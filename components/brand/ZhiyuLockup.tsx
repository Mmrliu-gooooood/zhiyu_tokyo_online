'use client';

import { cn } from '@/lib/utils/cn';
import { useBrand } from '@/lib/brand/brand-context';
import { BRAND_ENGLISH_NAME } from '@/lib/brand/brand-config';

export function ZhiyuLockup({
  size = 'md',
  showEnglish = true,
  className,
}: {
  readonly size?: 'sm' | 'md' | 'lg';
  readonly showEnglish?: boolean;
  readonly className?: string;
}) {
  const brand = useBrand();
  const markSize = size === 'lg' ? 'size-9' : size === 'sm' ? 'size-6' : 'size-7';
  const textSize = size === 'lg' ? 'text-[24px]' : size === 'sm' ? 'text-[16px]' : 'text-[19px]';

  return (
    <div
      data-testid="zhiyu-brand-lockup"
      className={cn('inline-flex items-center gap-2.5', className)}
      aria-label={`${brand.productName} ${BRAND_ENGLISH_NAME}`}
    >
      <img src={brand.markSrc} alt="" aria-hidden="true" className={markSize} />
      <div className="flex items-baseline gap-2">
        <span className={cn('font-semibold tracking-[-0.02em] text-foreground', textSize)}>
          {brand.shortName}
        </span>
        {showEnglish ? (
          <span className="text-[10px] font-semibold tracking-[0.16em] text-muted-foreground">
            {BRAND_ENGLISH_NAME}
          </span>
        ) : null}
      </div>
    </div>
  );
}
