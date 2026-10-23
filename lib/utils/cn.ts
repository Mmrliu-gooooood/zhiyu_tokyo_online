import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The depth shadows defined in app/globals.css (`--shadow-*` in @theme). Without
// registering them, tailwind-merge reads `shadow-flat` as a shadow *color*, so
// it would not drop it for a caller's `shadow-none` but would for `shadow-red-500`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: [
        'flat',
        'sticker',
        'sticker-hover',
        'sticker-press',
        'feature',
        'float',
        'edge-primary',
        'edge-outline',
        'edge-outline-pressed',
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
