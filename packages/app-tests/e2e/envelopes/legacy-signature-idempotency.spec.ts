import { NEXT_PUBLIC_WEBAPP_URL } from '@documenso/lib/constants/app';
import { DOCUMENT_AUDIT_LOG_TYPE } from '@documenso/lib/types/document-audit-logs';
import { prisma } from '@documenso/prisma';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { FieldType } from '@prisma/client';

import { apiSeedPendingDocument } from '../fixtures/api-seeds';

const WEBAPP_BASE_URL = NEXT_PUBLIC_WEBAPP_URL();

const signLegacyField = async (
  request: APIRequestContext,
  payload: { token: string; fieldId: number; value: string; isBase64: boolean },
) => {
  return await request.post(`${WEBAPP_BASE_URL}/api/trpc/field.signFieldWithToken`, {
    headers: { 'content-type': 'application/json' },
    data: JSON.stringify({ json: payload }),
  });
};

test.describe('Legacy signature idempotency', () => {
  test('an identical retry confirms the saved signature without duplicating the audit log', async ({ request }) => {
    const { envelope, distributeResult } = await apiSeedPendingDocument(request, {
      title: '[TEST] Legacy signature idempotency',
      recipients: [{ email: 'legacy-retry@test.documenso.com', name: 'Legacy Retry Signer' }],
      fieldsPerRecipient: [[{ type: FieldType.SIGNATURE, page: 1, positionX: 5, positionY: 5, width: 15, height: 5 }]],
    });

    const signatureField = envelope.fields.find((field) => field.type === FieldType.SIGNATURE);
    const recipient = distributeResult.recipients[0];

    if (!signatureField || !recipient) {
      throw new Error('Expected a signature field and recipient');
    }

    const payload = {
      token: recipient.token,
      fieldId: signatureField.id,
      value: 'Legacy Retry Signer',
      isBase64: false,
    };

    const firstResponse = await signLegacyField(request, payload);
    expect(firstResponse.ok(), `Initial signature failed: ${await firstResponse.text()}`).toBeTruthy();

    const retryResponse = await signLegacyField(request, payload);
    expect(retryResponse.ok(), `Signature retry failed: ${await retryResponse.text()}`).toBeTruthy();

    const savedField = await prisma.field.findUniqueOrThrow({
      where: { id: signatureField.id },
      include: { signature: true },
    });

    expect(savedField.inserted).toBe(true);
    expect(savedField.signature?.typedSignature).toBe(payload.value);

    const insertionAuditLogCount = await prisma.documentAuditLog.count({
      where: {
        envelopeId: envelope.id,
        type: DOCUMENT_AUDIT_LOG_TYPE.DOCUMENT_FIELD_INSERTED,
      },
    });

    expect(insertionAuditLogCount).toBe(1);

    const conflictingRetryResponse = await signLegacyField(request, {
      ...payload,
      value: 'Different Signature',
    });

    expect(conflictingRetryResponse.ok()).toBe(false);
  });
});
