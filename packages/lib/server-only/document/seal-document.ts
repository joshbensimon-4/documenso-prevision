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

import PostHogServerClient from '@documenso/lib/server-only/feature-flags/get-post-hog-server-client';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { createDocumentAuditLogData } from '@documenso/lib/utils/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { signPdf } from '@documenso/signing';

import {
  ZWebhookDocumentSchema,
  mapDocumentToWebhookDocumentPayload,
} from '../../types/webhook-payload';
import type { RequestMetadata } from '../../universal/extract-request-metadata';
import { getFileServerSide } from '../../universal/upload/get-file.server';
import { putPdfFileServerSide } from '../../universal/upload/put-file.server';
import { fieldsContainUnsignedRequiredField } from '../../utils/advanced-fields-helpers';
import { getCertificatePdf } from '../htmltopdf/get-certificate-pdf';
import { addRejectionStampToPdf } from '../pdf/add-rejection-stamp-to-pdf';
import { flattenAnnotations } from '../pdf/flatten-annotations';
import { flattenForm } from '../pdf/flatten-form';
import { insertFieldInPDF } from '../pdf/insert-field-in-pdf';
import { legacy_insertFieldInPDF } from '../pdf/legacy-insert-field-in-pdf';
import { normalizeSignatureAppearances } from '../pdf/normalize-signature-appearances';
import { triggerWebhook } from '../webhooks/trigger/trigger-webhook';
import { sendCompletedEmail } from './send-completed-email';

export type SealDocumentOptions = {
  documentId: number;
  sendEmail?: boolean;
  isResealing?: boolean;
  requestMetadata?: RequestMetadata;
};

export const sealDocument = async ({
  documentId,
  sendEmail = true,
  isResealing = false,
  requestMetadata,
}: SealDocumentOptions) => {
  const document = await prisma.document.findFirstOrThrow({
    where: {
      id: documentId,
    },
    include: {
      documentData: true,
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

  const { documentData } = document;

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

  // If the document is not rejected, ensure all recipients have signed
  if (
    !isRejected &&
    recipients.some((recipient) => recipient.signingStatus !== SigningStatus.SIGNED)
  ) {
    throw new Error(`Document ${document.id} has unsigned recipients`);
  }

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

  // !: Need to write the fields onto the document as a hard copy
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

  const doc = await PDFDocument.load(pdfData);

  // Normalize and flatten layers that could cause issues with the signature
  normalizeSignatureAppearances(doc);
  flattenForm(doc);
  flattenAnnotations(doc);

  // Add rejection stamp if the document is rejected
  if (isRejected && rejectionReason) {
    await addRejectionStampToPdf(doc, rejectionReason);
  }

  // For non-signature fields, draw them directly on the PDF as text instead of using fields
  for (const field of nonSignatureFields) {
    const pages = doc.getPages();
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
    const font = await doc.embedFont('Helvetica');
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
      const certificate = await PDFDocument.load(Uint8Array.from(certificateData));
      const certificatePages = await doc.copyPages(certificate, certificate.getPageIndices());
      certificatePages.forEach((page) => {
        doc.addPage(page);
      });
    }

    // Process signature fields using the proper field mechanism
    for (const field of signatureFields) {
      document.useLegacyFieldInsertion
        ? await legacy_insertFieldInPDF(doc, field)
        : await insertFieldInPDF(doc, field);
    }
  }

  // Re-flatten post-insertion to handle fields that create arcoFields
  flattenForm(doc);

  const pdfBytes = await doc.save();
  const pdfBuffer = await signPdf({ pdf: Buffer.from(pdfBytes) });

  const { name } = path.parse(document.title);

  // Add suffix based on document status
  const suffix = isRejected ? '_rejected.pdf' : '_signed.pdf';

  const { data: newData } = await putPdfFileServerSide({
    name: `${name}${suffix}`,
    type: 'application/pdf',
    arrayBuffer: async () => Promise.resolve(pdfBuffer.buffer as ArrayBuffer),
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

  await prisma.$transaction(async (tx) => {
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
        data: newData,
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
          ...(isRejected ? { isRejected: true, rejectionReason } : {}),
        },
      }),
    });
  });

  if (sendEmail && !isResealing) {
    await sendCompletedEmail({ documentId, requestMetadata });
  }

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
    userId: document.userId,
    teamId: document.teamId ?? undefined,
  });
};
