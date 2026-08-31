'use client';

import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { Atom, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

type DataAttributes = {
  [key: `data-${string}`]: string | number | boolean | undefined;
};

type InteractiveModeButtonProps = Omit<
  ComponentPropsWithoutRef<'button'>,
  'aria-pressed' | 'children'
> &
  DataAttributes & {
    pressed: boolean;
    label: string;
    onPressedChange: (pressed: boolean) => void;
  };

export const InteractiveModeButton = forwardRef<HTMLButtonElement, InteractiveModeButtonProps>(
  function InteractiveModeButton(
    { pressed, label, onPressedChange, className, onClick, ...buttonProps },
    ref,
  ) {
    return (
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        aria-pressed={pressed}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onPressedChange(!pressed);
        }}
        className={cn(
          'relative inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-all active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none motion-reduce:active:scale-100 dark:focus-visible:outline-primary',
          pressed
            ? 'border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/20 dark:border-primary dark:bg-primary dark:text-primary-foreground dark:shadow-primary/40'
            : 'border-primary bg-transparent text-primary hover:bg-primary/10 dark:border-primary dark:text-primary dark:hover:bg-primary/15',
          className,
        )}
      >
        {pressed && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-[-4px] rounded-full border border-primary/40 dark:border-primary/60 motion-safe:dark:animate-[interactive-mode-breathe_2s_ease-in-out_infinite]"
          />
        )}
        {pressed ? (
          <Check aria-hidden="true" className="relative z-10 size-3.5" />
        ) : (
          <Atom aria-hidden="true" className="relative z-10 size-3.5" />
        )}
        <span className="relative z-10">{label}</span>
      </button>
    );
  },
);
