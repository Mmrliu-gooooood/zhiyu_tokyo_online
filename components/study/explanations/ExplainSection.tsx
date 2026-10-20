'use client';

/**
 * The last step of help on a wrong question (learning plan B13): after the
 * question's own explanation, looking back and asking a classmate, the
 * student may ask for an explanation written for this question — text, a
 * whiteboard, a light interactive page or a full course. Nothing is
 * generated until they choose a form and confirm; the same inputs open the
 * saved explanation instead of calling the model again.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  BookOpen,
  FileText,
  LoaderCircle,
  MousePointerClick,
  PenLine,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { newRequestKey } from '@/components/study/exams/exam-format';
import { RelativeTime } from '@/components/study/spaces/study-format';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import {
  courseGenerationHref,
  explanationApi,
  explanationHref,
} from '@/lib/study/explanations/client';
import {
  EXPLANATION_LIMITS,
  type CourseMedia,
  type ExplanationFormat,
  type ExplanationSummary,
} from '@/lib/study/explanations/contracts';
import { StudyApiError } from '@/lib/study/spaces/client';
import { cn } from '@/lib/utils';

export const FORMAT_ICONS: Record<ExplanationFormat, typeof FileText> = {
  text: FileText,
  whiteboard: PenLine,
  interactive: MousePointerClick,
  course: BookOpen,
};

const FORMATS: ExplanationFormat[] = ['text', 'whiteboard', 'interactive', 'course'];

export function useExplanationStatusLabel() {
  const { t } = useI18n();
  return (item: Pick<ExplanationSummary, 'status' | 'format' | 'stageId' | 'jobId'>) => {
    if (item.status === 'pending') {
      return item.format === 'course'
        ? item.jobId
          ? t('study.explain.status.courseRunning')
          : t('study.explain.status.courseWaiting')
        : t('study.explain.status.pending');
    }
    return t(`study.explain.status.${item.status}`);
  };
}

export function ExplainSection({ spaceId, itemId }: { spaceId: string; itemId: string }) {
  const { t } = useI18n();
  const statusLabel = useExplanationStatusLabel();
  const [items, setItems] = useState<ExplanationSummary[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    explanationApi
      .list(spaceId, itemId)
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId, itemId]);

  return (
    <section className="space-y-2" data-testid="explain-section">
      <h3 className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Sparkles className="size-3.5" />
        {t('study.explain.title')}
      </h3>
      {items && items.length ? (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {items.slice(0, 5).map((item) => {
            const Icon = FORMAT_ICONS[item.format];
            return (
              <li key={item.id}>
                <Link
                  href={explanationHref(spaceId, item.id)}
                  className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/40"
                  data-testid="explain-item"
                >
                  <Icon className="size-3.5 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-foreground">
                    {item.title ?? t(`study.explain.format.${item.format}`)}
                  </span>
                  <span
                    className={cn(
                      'shrink-0',
                      item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    {statusLabel(item)}
                  </span>
                  <RelativeTime iso={item.createdAt} />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('study.explain.intro')}</p>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="explain-open">
        <Sparkles className="mr-1 size-4" />
        {t('study.explain.open')}
      </Button>
      <ExplainDialog spaceId={spaceId} itemId={itemId} open={open} onOpenChange={setOpen} />
    </section>
  );
}

function ExplainDialog({
  spaceId,
  itemId,
  open,
  onOpenChange,
}: {
  spaceId: string;
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const settings = useSettingsStore();
  const [format, setFormat] = useState<ExplanationFormat>('text');
  const [media, setMedia] = useState<CourseMedia>({ image: false, tts: false, video: false });
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newRequestKey);
  // Media a course may use: only what is set up in settings, and each off until ticked.
  const available: CourseMedia = {
    image: settings.imageGenerationEnabled,
    tts: settings.ttsEnabled,
    video: settings.videoGenerationEnabled,
  };

  async function confirm() {
    setBusy(true);
    try {
      const course = format === 'course';
      const result = await explanationApi.create({
        itemId,
        format,
        language: locale,
        idempotencyKey: key,
        ...(course
          ? {
              media: {
                image: media.image && available.image,
                tts: media.tts && available.tts,
                video: media.video && available.video,
              },
            }
          : {}),
      });
      const explanation = result.explanation;
      if (result.reused)
        toast.info(t(course ? 'study.explain.courseReused' : 'study.explain.reused'));
      onOpenChange(false);
      setKey(newRequestKey());
      if (course && !explanation.stageId && !explanation.jobId) {
        // A full load: Home reads its study target from the address once, when it mounts.
        window.location.assign(courseGenerationHref(spaceId, explanation.id));
      } else {
        router.push(explanationHref(spaceId, explanation.id));
      }
    } catch (error) {
      setKey(newRequestKey());
      toast.error(
        error instanceof StudyApiError && error.code === 'STUDY_EXPLANATION_LIMIT'
          ? t('study.explain.limit', { count: EXPLANATION_LIMITS.perDay })
          : t('study.errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        data-testid="explain-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t('study.explain.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('study.explain.dialogIntro')}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" className="space-y-2">
          {FORMATS.map((value) => {
            const Icon = FORMAT_ICONS[value];
            const selected = format === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setFormat(value)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left',
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
                )}
                data-testid={`explain-format-${value}`}
              >
                <Icon className={cn('mt-0.5 size-4 shrink-0', selected && 'text-primary')} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">
                    {t(`study.explain.format.${value}`)}
                  </span>
                  <span className="block text-xs leading-5 text-muted-foreground">
                    {t(`study.explain.formatHint.${value}`, {
                      count: EXPLANATION_LIMITS.callCap[value],
                    })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {format === 'course' ? (
          <fieldset className="space-y-1.5 rounded-xl bg-muted/40 px-3 py-2.5">
            <legend className="sr-only">{t('study.explain.media.title')}</legend>
            <p className="text-xs font-medium text-foreground">{t('study.explain.media.title')}</p>
            {(['image', 'tts', 'video'] as const).map((kind) => (
              <label
                key={kind}
                className={cn(
                  'flex items-center gap-2 text-xs',
                  available[kind] ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <Checkbox
                  checked={media[kind] && available[kind]}
                  disabled={!available[kind]}
                  onCheckedChange={(checked) =>
                    setMedia((current) => ({ ...current, [kind]: checked === true }))
                  }
                  data-testid={`explain-media-${kind}`}
                />
                {t(`study.explain.media.${kind}`)}
                {available[kind] ? null : (
                  <span className="text-[11px]">{t('study.explain.media.unavailable')}</span>
                )}
              </label>
            ))}
            <p className="text-[11px] leading-4 text-muted-foreground">
              {t('study.explain.media.note')}
            </p>
          </fieldset>
        ) : null}
        <p className="text-xs leading-5 text-muted-foreground">
          {format === 'course' ? t('study.explain.consentCourse') : t('study.explain.consent')}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('study.explain.cancel')}
          </Button>
          <Button onClick={() => void confirm()} disabled={busy} data-testid="explain-confirm">
            {busy ? <LoaderCircle className="mr-1 size-4 animate-spin" /> : null}
            {format === 'course' ? t('study.explain.confirmCourse') : t('study.explain.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
