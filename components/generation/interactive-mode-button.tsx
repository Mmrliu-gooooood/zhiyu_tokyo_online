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
          'relative inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[13px] font-medium transition-all active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none motion-reduce:active:scale-100',
          // A soft fill when on: the send button stays the only solid primary.
          pressed
            ? 'border-primary/30 bg-primary-soft text-primary-ink'
            : 'border-border bg-card text-foreground hover:bg-muted',
          className,
        )}
      >
        {pressed && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-[-3px] rounded-[10px] border border-primary/30 motion-safe:dark:animate-[interactive-mode-breathe_2s_ease-in-out_infinite]"
          />
        )}
        {pressed ? (
          <Check aria-hidden="true" className="relative z-10 size-3.5" />
        ) : (
          <Atom aria-hidden="true" className="relative z-10 size-3.5 text-muted-foreground" />
        )}
        <span className="relative z-10">{label}</span>
      </button>
    );
  },
);
