import { Loader } from 'lucide-react';

import { cn } from '@documenso/ui/lib/utils';

export const DocumentSigningFieldsLoader = () => {
  return (
    <div className="bg-background absolute inset-0 flex items-center justify-center rounded-md">
      <Loader className="text-primary h-5 w-5 animate-spin md:h-8 md:w-8" />
    </div>
  );
};

export const DocumentSigningFieldsUninserted = ({ children }: { children: React.ReactNode }) => {
  return (
    <p className="group-hover:text-primary text-foreground group-hover:text-recipient-green text-wrap-field overflow-visible break-words text-[0.45rem] duration-200 sm:text-[0.55rem]">
      {children}
    </p>
  );
};

type DocumentSigningFieldsInsertedProps = {
  children: React.ReactNode;

  /**
   * The text alignment of the field.
   *
   * Defaults to left.
   */
  textAlign?: 'left' | 'center' | 'right';
};

export const DocumentSigningFieldsInserted = ({
  children,
  textAlign = 'left',
}: DocumentSigningFieldsInsertedProps) => {
  return (
    <div className="flex h-full w-full items-center overflow-visible">
      <p
        className={cn(
          'text-foreground text-wrap-field w-full max-w-full overflow-visible whitespace-normal break-words text-left text-[0.45rem] duration-200 sm:text-[0.55rem]',
          {
            '!text-center': textAlign === 'center',
            '!text-right': textAlign === 'right',
          },
        )}
      >
        {children}
      </p>
    </div>
  );
};
