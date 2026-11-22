import * as React from 'react';

import { fieldClassName } from '@/components/ui/field';
import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        fieldClassName,
        'flex field-sizing-content min-h-16 w-full px-3 py-2',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
