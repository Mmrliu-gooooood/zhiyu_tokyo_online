import type { ReactNode } from 'react';
import { CircleAlert, FileQuestion, Loader2 } from 'lucide-react';
import { ZhiyuLockup } from '@/components/brand/ZhiyuLockup';
import { cn } from '@/lib/utils';

export function ZhiyuClassroomState({
  kind,
  title,
  description,
  action,
  testId,
}: {
  readonly kind: 'loading' | 'error' | 'notFound';
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly testId?: string;
}) {
  const Icon = kind === 'loading' ? Loader2 : kind === 'error' ? CircleAlert : FileQuestion;
  return (
    <div
      data-testid={testId}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
      className="flex min-h-0 flex-1 items-center justify-center bg-background px-6"
    >
      <div className="flex w-full max-w-md flex-col items-center rounded-3xl border border-border/70 bg-card px-8 py-10 text-center shadow-[0_20px_50px_rgba(20,26,46,0.08)]">
        <ZhiyuLockup size="sm" className="mb-8" />
        <div
          className={cn(
            'mb-4 flex size-12 items-center justify-center rounded-full',
            kind === 'error' && 'bg-destructive/10 text-destructive',
            kind === 'notFound' && 'bg-[var(--zhiyu-learning-soft)] text-[var(--zhiyu-learning)]',
            kind === 'loading' && 'bg-secondary text-primary',
          )}
        >
          <Icon className={cn('size-5', kind === 'loading' && 'animate-spin')} />
        </div>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        {description ? (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        ) : null}
        {action ? <div className="mt-6">{action}</div> : null}
      </div>
    </div>
  );
}
