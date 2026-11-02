import { Trans } from '@lingui/react/macro';
import { Fragment } from 'react';

import { Link, Section, Text } from '../components';
import { useBranding } from '../providers/branding';

export type TemplateFooterProps = {
  isDocument?: boolean;
  reportUrl?: string;
};

export const TemplateFooter = ({ isDocument = true, reportUrl }: TemplateFooterProps) => {
  const branding = useBranding();

  return (
    <Section>
      {reportUrl && (
        <Text className="my-4 text-base text-muted-foreground">
          <Trans>
            Did not expect this email?{' '}
            <Link className="text-primary" href={reportUrl}>
              Click here to report the sender
            </Link>
            . Never sign a document you don't recognize or weren't expecting.
          </Trans>
        </Text>
      )}

      {isDocument && !branding.brandingHidePoweredBy && branding.brandingCompanyDetails ? (
        <Text className="my-8 text-slate-400 text-sm">
          {branding.brandingCompanyDetails.split('\n').map((line, idx) => {
            return (
              <Fragment key={idx}>
                {idx > 0 && <br />}
                {line}
              </Fragment>
            );
          })}
        </Text>
      ) : null}
    </Section>
  );
};

export default TemplateFooter;
