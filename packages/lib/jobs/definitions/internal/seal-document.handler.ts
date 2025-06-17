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
      
      // Draw the text directly on the PDF with word wrapping
      const fontSize = 8; // Set an appropriate font size
      const font = await pdfDoc.embedFont('Helvetica');
      const padding = 4; // Padding inside the field

      if (field.customText) {
        // Break text into lines that fit within the field width
        const availableWidth = fieldWidth - (padding * 2);
        const wrappedText = breakLongString(field.customText, availableWidth, font, fontSize);
        const lines = wrappedText.split('\n');
        
        // Calculate line height based on font size
        const lineHeight = fontSize * 1.2; // 20% extra space between lines
        
        // Start from the top of the field
        let currentY = invertedY + fieldHeight - padding - fontSize;
        
        // Draw each line
        for (const line of lines) {
          // Stop if we've run out of vertical space
          if (currentY < invertedY + padding) {
            break;
          }
          
          page.drawText(line, {
            x: fieldX + padding,
            y: currentY,
            size: fontSize,
            font,
          });
          
          currentY -= lineHeight;
        }
      }
    }

    /**
     * Break a long string into multiple lines so it fits within a given width,
     * using natural word breaking similar to word processors.
     */
    function breakLongString(text: string, maxWidth: number, font: any, fontSize: number): string {
      if (!text) return '';

      const lines: string[] = [];

      // Process each original line separately to preserve newlines
      for (const paragraph of text.split('\n')) {
        // If paragraph fits on one line or is empty, add it as-is
        if (paragraph === '' || font.widthOfTextAtSize(paragraph, fontSize) <= maxWidth) {
          lines.push(paragraph);
          continue;
        }

        // Split paragraph into words
        const words = paragraph.split(' ');
        let currentLine = '';

        for (const word of words) {
          // Check if adding word to current line would exceed max width
          const lineWithWord = currentLine.length === 0 ? word : `${currentLine} ${word}`;

          if (font.widthOfTextAtSize(lineWithWord, fontSize) <= maxWidth) {
            // Word fits, add it to current line
            currentLine = lineWithWord;
          } else {
            // Word doesn't fit on current line

            // First, save current line if it's not empty
            if (currentLine.length > 0) {
              lines.push(currentLine);
              currentLine = '';
            }

            // Check if word fits on a line by itself
            if (font.widthOfTextAtSize(word, fontSize) <= maxWidth) {
              // Word fits on its own line
              currentLine = word;
            } else {
              // Word is too long, need to break it character by character
              let charLine = '';

              // Process each character in the word
              for (const char of word) {
                const nextCharLine = charLine + char;

                if (font.widthOfTextAtSize(nextCharLine, fontSize) <= maxWidth) {
                  // Character fits, add it
                  charLine = nextCharLine;
                } else {
                  // Character doesn't fit, push current charLine and start a new one
                  lines.push(charLine);
                  charLine = char;
                }
              }

              // Add any remaining characters as the current line
              currentLine = charLine;
            }
          }
        }

        // Add the last line if not empty
        if (currentLine.length > 0) {
          lines.push(currentLine);
        }
      }

      return lines.join('\n');
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
