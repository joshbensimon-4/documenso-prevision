import {
  DocumentStatus,
  FieldType,
  RecipientRole,
  SigningStatus,
  WebhookTriggerEvents,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

import { prisma } from '@documenso/prisma';
import { signPdf } from '@documenso/signing';

import { AppError, AppErrorCode } from '../../../errors/app-error';
import { sendCompletedEmail } from '../../../server-only/document/send-completed-email';
import PostHogServerClient from '../../../server-only/feature-flags/get-post-hog-server-client';
import { getCertificatePdf } from '../../../server-only/htmltopdf/get-certificate-pdf';
import { addRejectionStampToPdf } from '../../../server-only/pdf/add-rejection-stamp-to-pdf';
import { flattenAnnotations } from '../../../server-only/pdf/flatten-annotations';
import { flattenForm } from '../../../server-only/pdf/flatten-form';
import { insertFieldInPDF } from '../../../server-only/pdf/insert-field-in-pdf';
import { legacy_insertFieldInPDF } from '../../../server-only/pdf/legacy-insert-field-in-pdf';
import { normalizeSignatureAppearances } from '../../../server-only/pdf/normalize-signature-appearances';
import { triggerWebhook } from '../../../server-only/webhooks/trigger/trigger-webhook';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import {
  ZWebhookDocumentSchema,
  mapDocumentToWebhookDocumentPayload,
} from '../../../types/webhook-payload';
import { prefixedId } from '../../../universal/id';
import { getFileServerSide } from '../../../universal/upload/get-file.server';
import { putPdfFileServerSide } from '../../../universal/upload/put-file.server';
import { fieldsContainUnsignedRequiredField } from '../../../utils/advanced-fields-helpers';
import { isDocumentCompleted } from '../../../utils/document';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSealDocumentJobDefinition } from './seal-document';

export const run = async ({
  payload,
  io,
}: {
  payload: TSealDocumentJobDefinition;
  io: JobRunIO;
}) => {
  const { documentId, sendEmail = true, isResealing = false, requestMetadata } = payload;

  const document = await prisma.document.findFirstOrThrow({
    where: {
      id: documentId,
    },
    include: {
      documentMeta: true,
      recipients: true,
      team: {
        select: {
          teamGlobalSettings: {
            select: {
              includeSigningCertificate: true,
            },
          },
        },
      },
    },
  });

  const isComplete =
    document.recipients.some((recipient) => recipient.signingStatus === SigningStatus.REJECTED) ||
    document.recipients.every((recipient) => recipient.signingStatus === SigningStatus.SIGNED);

  if (!isComplete) {
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: 'Document is not complete',
    });
  }

  // Seems silly but we need to do this in case the job is re-ran
  // after it has already run through the update task further below.
  // eslint-disable-next-line @typescript-eslint/require-await
  const documentStatus = await io.runTask('get-document-status', async () => {
    return document.status;
  });

  // This is the same case as above.
  // eslint-disable-next-line @typescript-eslint/require-await
  const documentDataId = await io.runTask('get-document-data-id', async () => {
    return document.documentDataId;
  });

  const documentData = await prisma.documentData.findFirst({
    where: {
      id: documentDataId,
    },
  });

  if (!documentData) {
    throw new Error(`Document ${document.id} has no document data`);
  }

  const recipients = await prisma.recipient.findMany({
    where: {
      documentId: document.id,
      role: {
        not: RecipientRole.CC,
      },
    },
  });

  // Determine if the document has been rejected by checking if any recipient has rejected it
  const rejectedRecipient = recipients.find(
    (recipient) => recipient.signingStatus === SigningStatus.REJECTED,
  );

  const isRejected = Boolean(rejectedRecipient);

  // Get the rejection reason from the rejected recipient
  const rejectionReason = rejectedRecipient?.rejectionReason ?? '';

  const fields = await prisma.field.findMany({
    where: {
      documentId: document.id,
    },
    include: {
      signature: true,
    },
  });

  // Skip the field check if the document is rejected
  if (!isRejected && fieldsContainUnsignedRequiredField(fields)) {
    throw new Error(`Document ${document.id} has unsigned required fields`);
  }

  if (isResealing) {
    // If we're resealing we want to use the initial data for the document
    // so we aren't placing fields on top of eachother.
    documentData.data = documentData.initialData;
  }

  if (!document.qrToken) {
    await prisma.document.update({
      where: {
        id: document.id,
      },
      data: {
        qrToken: prefixedId('qr'),
      },
    });
  }

  const pdfData = await getFileServerSide(documentData);

  // Separate signature fields from non-signature fields
  const signatureFields = fields.filter(
    (field) => field.type === FieldType.SIGNATURE || field.type === FieldType.FREE_SIGNATURE,
  );

  const nonSignatureFields = fields.filter(
    (field) => field.type !== FieldType.SIGNATURE && field.type !== FieldType.FREE_SIGNATURE,
  );

  const hasSignatureField = signatureFields.length > 0;

  const certificateData =
    hasSignatureField && (document.team?.teamGlobalSettings?.includeSigningCertificate ?? true)
      ? await getCertificatePdf({
          documentId,
          language: document.documentMeta?.language,
        }).catch(() => null)
      : null;

  const newDataId = await io.runTask('decorate-and-sign-pdf', async () => {
    const pdfDoc = await PDFDocument.load(pdfData);

    // Normalize and flatten layers that could cause issues with the signature
    normalizeSignatureAppearances(pdfDoc);
    flattenForm(pdfDoc);
    flattenAnnotations(pdfDoc);

    // Add rejection stamp if the document is rejected
    if (isRejected && rejectionReason) {
      await addRejectionStampToPdf(pdfDoc, rejectionReason);
    }

    // For non-signature fields, draw them directly on the PDF as text instead of using fields
    for (const field of nonSignatureFields) {
      if (!field.inserted) {
        continue;
      }

      const pages = pdfDoc.getPages();
      const page = pages.at(field.page - 1);

      if (!page) {
        continue;
      }

      const pageWidth = page.getWidth();
      const pageHeight = page.getHeight();

      const fieldWidth = pageWidth * (Number(field.width) / 100);
      const fieldHeight = pageHeight * (Number(field.height) / 100);

      const fieldX = pageWidth * (Number(field.positionX) / 100);
      const fieldY = pageHeight * (Number(field.positionY) / 100);

      // Invert the Y axis since PDFs use a bottom-left coordinate system
      const invertedY = pageHeight - fieldY - fieldHeight;

      // Draw the text directly on the PDF
      const fontSize = 8; // Set an appropriate font size
      const font = await pdfDoc.embedFont('Helvetica');

      if (field.customText) {
        page.drawText(field.customText, {
          x: fieldX + 2, // Small padding
          y: invertedY + fieldHeight / 2 - fontSize / 2, // Center text vertically
          size: fontSize,
          font,
        });
      }
    }

    // If we have signature fields, add the certificate and process the signature fields
    if (hasSignatureField) {
      if (certificateData) {
        const certificateDoc = await PDFDocument.load(Uint8Array.from(certificateData));
        const certificatePages = await pdfDoc.copyPages(
          certificateDoc,
          certificateDoc.getPageIndices(),
        );
        certificatePages.forEach((page) => {
          pdfDoc.addPage(page);
        });
      }

      // Process signature fields using the proper field mechanism
      for (const field of signatureFields) {
        if (field.inserted) {
          document.useLegacyFieldInsertion
            ? await legacy_insertFieldInPDF(pdfDoc, field)
            : await insertFieldInPDF(pdfDoc, field);
        }
      }
    }

    // Re-flatten the form to handle our checkbox and radio fields that
    // create native arcoFields
    flattenForm(pdfDoc);

    const pdfBytes = await pdfDoc.save();
    const pdfBuffer = await signPdf({ pdf: Buffer.from(pdfBytes) });

    const { name } = path.parse(document.title);

    // Add suffix based on document status
    const suffix = isRejected ? '_rejected.pdf' : '_signed.pdf';

    const documentData = await putPdfFileServerSide({
      name: `${name}${suffix}`,
      type: 'application/pdf',
      arrayBuffer: async () => Promise.resolve(pdfBuffer.buffer as ArrayBuffer),
    });

    return documentData.id;
  });

  const postHog = PostHogServerClient();

  if (postHog) {
    postHog.capture({
      distinctId: nanoid(),
      event: 'App: Document Sealed',
      properties: {
        documentId: document.id,
        isRejected,
      },
    });
  }

  await io.runTask('update-document', async () => {
    await prisma.$transaction(async (tx) => {
      const newData = await tx.documentData.findFirstOrThrow({
        where: {
          id: newDataId,
        },
      });

      await tx.document.update({
        where: {
          id: document.id,
        },
        data: {
          status: isRejected ? DocumentStatus.REJECTED : DocumentStatus.COMPLETED,
          completedAt: new Date(),
        },
      });

      await tx.documentData.update({
        where: {
          id: documentData.id,
        },
        data: {
          data: newData.data,
        },
      });

      await tx.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_COMPLETED,
          documentId: document.id,
          requestMetadata,
          user: null,
          data: {
            transactionId: nanoid(),
            ...(isRejected ? { isRejected: true, rejectionReason: rejectionReason } : {}),
          },
        }),
      });
    });
  });

  await io.runTask('send-completed-email', async () => {
    let shouldSendCompletedEmail = sendEmail && !isResealing && !isRejected;

    if (isResealing && !isDocumentCompleted(document.status)) {
      shouldSendCompletedEmail = sendEmail;
    }

    if (shouldSendCompletedEmail) {
      await sendCompletedEmail({ documentId, requestMetadata });
    }
  });

  const updatedDocument = await prisma.document.findFirstOrThrow({
    where: {
      id: document.id,
    },
    include: {
      documentData: true,
      documentMeta: true,
      recipients: true,
    },
  });

  await triggerWebhook({
    event: isRejected
      ? WebhookTriggerEvents.DOCUMENT_REJECTED
      : WebhookTriggerEvents.DOCUMENT_COMPLETED,
    data: ZWebhookDocumentSchema.parse(mapDocumentToWebhookDocumentPayload(updatedDocument)),
    userId: updatedDocument.userId,
    teamId: updatedDocument.teamId ?? undefined,
  });
};
