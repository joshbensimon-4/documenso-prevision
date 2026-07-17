import { DO_NOT_INVALIDATE_QUERY_ON_MUTATION } from '@documenso/lib/constants/trpc';
import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { TRecipientActionAuth } from '@documenso/lib/types/document-auth';
import type { FieldWithSignature } from '@documenso/prisma/types/field-with-signature';
import { trpc } from '@documenso/trpc/react';
import type {
  TRemovedSignedFieldWithTokenMutationSchema,
  TSignFieldWithTokenMutationSchema,
} from '@documenso/trpc/server/field-router/schema';
import { Button } from '@documenso/ui/primitives/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@documenso/ui/primitives/dialog';
import { SignaturePad } from '@documenso/ui/primitives/signature-pad';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Loader } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';

import { DocumentSigningDisclosure } from '~/components/general/document-signing/document-signing-disclosure';

import { useRequiredDocumentSigningAuthContext } from './document-signing-auth-provider';
import { DocumentSigningFieldContainer } from './document-signing-field-container';
import { useRequiredDocumentSigningContext } from './document-signing-provider';
import { useDocumentSigningRecipientContext } from './document-signing-recipient-provider';

type SignatureFieldState = 'empty' | 'signed-image' | 'signed-text';

type LocalSignatureFieldOverride = {
  basedOnInserted: boolean;
  inserted: boolean;
  signature: string | null;
  isBase64: boolean;
};

export type DocumentSigningSignatureFieldProps = {
  field: FieldWithSignature;
  onSignField?: (value: TSignFieldWithTokenMutationSchema) => Promise<void> | void;
  onUnsignField?: (value: TRemovedSignedFieldWithTokenMutationSchema) => Promise<void> | void;
  typedSignatureEnabled?: boolean;
  uploadSignatureEnabled?: boolean;
  drawSignatureEnabled?: boolean;
};

export const DocumentSigningSignatureField = ({
  field,
  onSignField,
  onUnsignField,
  typedSignatureEnabled,
  uploadSignatureEnabled,
  drawSignatureEnabled,
}: DocumentSigningSignatureFieldProps) => {
  const { _ } = useLingui();
  const { toast } = useToast();
  const { revalidate } = useRevalidator();

  const { recipient } = useDocumentSigningRecipientContext();

  const signatureRef = useRef<HTMLParagraphElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState(2);

  const {
    fullName,
    signature: providedSignature,
    setSignature: setProvidedSignature,
  } = useRequiredDocumentSigningContext();

  const { executeActionAuthProcedure } = useRequiredDocumentSigningAuthContext();

  const { mutateAsync: signFieldWithToken, isPending: isSignFieldWithTokenLoading } =
    trpc.field.signFieldWithToken.useMutation(DO_NOT_INVALIDATE_QUERY_ON_MUTATION);

  const { mutateAsync: removeSignedFieldWithToken, isPending: isRemoveSignedFieldWithTokenLoading } =
    trpc.field.removeSignedFieldWithToken.useMutation(DO_NOT_INVALIDATE_QUERY_ON_MUTATION);

  const { signature } = field;

  const isLoading = isSignFieldWithTokenLoading || isRemoveSignedFieldWithTokenLoading;

  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const [localSignature, setLocalSignature] = useState<string | null>(null);
  const [localFieldOverride, setLocalFieldOverride] = useState<LocalSignatureFieldOverride | null>(null);

  const activeLocalFieldOverride = localFieldOverride?.basedOnInserted === field.inserted ? localFieldOverride : null;
  const isFieldInserted = activeLocalFieldOverride?.inserted ?? field.inserted;
  const signatureImageAsBase64 = activeLocalFieldOverride
    ? activeLocalFieldOverride.inserted && activeLocalFieldOverride.isBase64
      ? activeLocalFieldOverride.signature
      : null
    : signature?.signatureImageAsBase64;
  const typedSignature = activeLocalFieldOverride
    ? activeLocalFieldOverride.inserted && !activeLocalFieldOverride.isBase64
      ? activeLocalFieldOverride.signature
      : null
    : signature?.typedSignature;
  const displayField = isFieldInserted === field.inserted ? field : { ...field, inserted: isFieldInserted };

  let state: SignatureFieldState = 'signed-text';

  if (!isFieldInserted) {
    state = 'empty';
  } else if (signatureImageAsBase64) {
    state = 'signed-image';
  }

  const revalidateWithoutMaskingMutation = async () => {
    try {
      await revalidate();
    } catch (err) {
      console.warn('The signature mutation succeeded, but the signing page could not be refreshed.', err);
      // Reload the signing frame so the parent flow receives authoritative field
      // state even when Remix revalidation fails after the server saved it.
      window.location.reload();
    }
  };

  const onPreSign = () => {
    if (!providedSignature) {
      setShowSignatureModal(true);
      return false;
    }

    return true;
  };
  /**
   * When the user clicks the sign button in the dialog where they enter their signature.
   */
  const onDialogSignClick = () => {
    setShowSignatureModal(false);
    setProvidedSignature(localSignature);

    if (!localSignature) {
      return;
    }

    void executeActionAuthProcedure({
      onReauthFormSubmit: async (authOptions) => await onSign(authOptions, localSignature),
      actionTarget: field.type,
    });
  };

  const onSign = async (authOptions?: TRecipientActionAuth, signature?: string) => {
    const value = signature || providedSignature;

    if (!value) {
      setShowSignatureModal(true);
      return;
    }

    const isTypedSignature = !value.startsWith('data:image');

    if (isTypedSignature && typedSignatureEnabled === false) {
      toast({
        title: _(msg`Error`),
        description: _(msg`Typed signatures are not allowed. Please draw your signature.`),
        variant: 'destructive',
      });

      return;
    }

    const payload: TSignFieldWithTokenMutationSchema = {
      token: recipient.token,
      fieldId: field.id,
      value,
      isBase64: !isTypedSignature,
      authOptions,
    };

    try {
      if (onSignField) {
        await onSignField(payload);
      } else {
        try {
          await signFieldWithToken(payload);
        } catch (err) {
          const error = AppError.parseError(err);

          if (error.code === AppErrorCode.UNAUTHORIZED) {
            throw error;
          }

          // Retry once to resolve an ambiguous network failure. The server treats
          // an identical signature retry as success when the first request already
          // committed, so this also verifies the saved server-side state.
          await signFieldWithToken(payload);
        }
      }
    } catch (err) {
      const error = AppError.parseError(err);

      if (error.code === AppErrorCode.UNAUTHORIZED) {
        throw error;
      }

      console.error(err);

      toast({
        title: _(msg`Error`),
        description: _(msg`An error occurred while signing the document.`),
        variant: 'destructive',
      });

      return;
    }

    setLocalFieldOverride({
      basedOnInserted: field.inserted,
      inserted: true,
      signature: value,
      isBase64: !isTypedSignature,
    });

    await revalidateWithoutMaskingMutation();
  };

  const onRemove = async () => {
    try {
      const payload: TRemovedSignedFieldWithTokenMutationSchema = {
        token: recipient.token,
        fieldId: field.id,
      };

      if (onUnsignField) {
        await onUnsignField(payload);
        return;
      } else {
        await removeSignedFieldWithToken(payload);
      }

      setLocalFieldOverride({
        basedOnInserted: field.inserted,
        inserted: false,
        signature: null,
        isBase64: false,
      });

      await revalidateWithoutMaskingMutation();
    } catch (err) {
      console.error(err);

      toast({
        title: _(msg`Error`),
        description: _(msg`An error occurred while removing the signature.`),
        variant: 'destructive',
      });
    }
  };

  useEffect(() => {
    if (!signatureRef.current || !containerRef.current || !typedSignature) {
      return;
    }

    const adjustTextSize = () => {
      const container = containerRef.current;
      const text = signatureRef.current;

      if (!container || !text) {
        return;
      }

      let size = 2;
      text.style.fontSize = `${size}rem`;

      while ((text.scrollWidth > container.clientWidth || text.scrollHeight > container.clientHeight) && size > 0.8) {
        size -= 0.1;
        text.style.fontSize = `${size}rem`;
      }

      setFontSize(size);
    };

    const resizeObserver = new ResizeObserver(adjustTextSize);
    resizeObserver.observe(containerRef.current);

    adjustTextSize();

    return () => resizeObserver.disconnect();
  }, [typedSignature]);

  return (
    <DocumentSigningFieldContainer
      field={displayField}
      onPreSign={onPreSign}
      onSign={onSign}
      onRemove={onRemove}
      type="Signature"
    >
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-background">
          <Loader className="h-5 w-5 animate-spin text-primary md:h-8 md:w-8" />
        </div>
      )}

      {state === 'empty' && (
        <p className="font-signature text-[clamp(0.575rem,12cqw,1.2rem)] text-muted-foreground text-xl duration-200 group-hover:text-primary group-hover:text-recipient-green">
          <Trans>Signature</Trans>
        </p>
      )}

      {state === 'signed-image' && signatureImageAsBase64 && (
        <img
          src={signatureImageAsBase64}
          alt={`Signature for ${recipient.name}`}
          className="h-full w-full object-contain"
        />
      )}

      {state === 'signed-text' && (
        <div ref={containerRef} className="flex h-full w-full items-center justify-center p-2">
          <p
            ref={signatureRef}
            className="w-full overflow-hidden break-all text-center font-signature text-muted-foreground leading-tight duration-200"
            style={{ fontSize: `${fontSize}rem` }}
          >
            {typedSignature}
          </p>
        </div>
      )}

      <Dialog open={showSignatureModal} onOpenChange={setShowSignatureModal}>
        <DialogContent>
          <DialogTitle>
            <Trans>
              Sign as {recipient.name} <div className="h-5 text-muted-foreground">({recipient.email})</div>
            </Trans>
          </DialogTitle>

          <SignaturePad
            className="mt-2"
            fullName={fullName}
            value={localSignature ?? ''}
            onChange={({ value }) => setLocalSignature(value)}
            typedSignatureEnabled={typedSignatureEnabled}
            uploadSignatureEnabled={uploadSignatureEnabled}
            drawSignatureEnabled={drawSignatureEnabled}
          />

          <DocumentSigningDisclosure />

          <DialogFooter>
            <div className="flex w-full flex-1 flex-nowrap gap-4">
              <Button
                type="button"
                className="flex-1"
                variant="secondary"
                onClick={() => {
                  setShowSignatureModal(false);
                  setLocalSignature(null);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button type="button" className="flex-1" disabled={!localSignature} onClick={() => onDialogSignClick()}>
                <Trans>Sign</Trans>
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DocumentSigningFieldContainer>
  );
};
