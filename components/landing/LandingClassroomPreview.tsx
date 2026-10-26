'use client';

/**
 * The landing hero's illustration: a one-line request turning into a live
 * classroom (slide, teacher, classmate, in-class quiz). Built from the app's
 * own tokens so it follows the theme; purely decorative for screen readers.
 */
import { ArrowUp, CircleCheck } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';

const CURVE_WIDTH = 240;
const CURVE_HEIGHT = 96;

/** y = A·f(x) over one full period, as an SVG path across the chart width. */
function wavePath(f: (x: number) => number): string {
  const points = Array.from({ length: 49 }, (_, i) => {
    const x = (i / 48) * CURVE_WIDTH;
    const y = CURVE_HEIGHT / 2 - f((i / 48) * Math.PI * 2) * (CURVE_HEIGHT / 2 - 8);
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return points.join(' ');
}

const SIN_PATH = wavePath(Math.sin);
const COS_PATH = wavePath(Math.cos);

export function LandingClassroomPreview() {
  const { t } = useI18n();

  return (
    <div aria-hidden className="relative select-none">
      {/* The request, as typed into the composer */}
      <div className="relative z-10 mx-3 -mb-7 rounded-xl bg-card p-3 shadow-float sm:mx-8">
        <p className="text-[13px] leading-6 text-foreground sm:text-sm">
          {t('landing.previewPrompt')}
        </p>
        <div className="mt-2.5 flex items-center gap-2">
          <div className="flex -space-x-1.5">
            {['/avatars/teacher.png', '/avatars/curious.png', '/avatars/thinker.png'].map((src) => (
              <img
                key={src}
                src={src}
                alt=""
                className="size-6 rounded-full bg-muted ring-2 ring-card"
              />
            ))}
          </div>
          <span className="truncate text-xs text-muted-foreground">{t('landing.previewCast')}</span>
          <span className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-edge-primary">
            <ArrowUp className="size-4" />
          </span>
        </div>
      </div>

      {/* The classroom it becomes */}
      <div className="overflow-hidden rounded-3xl bg-card shadow-feature">
        <div className="grid grid-cols-1 gap-3 p-3 pt-10 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] sm:p-4 sm:pt-11">
          <div className="flex aspect-video flex-col rounded-xl bg-background p-3.5 shadow-flat sm:p-4">
            <div className="flex items-baseline justify-between gap-2">
              <p className="truncate font-display text-[15px] font-bold text-foreground sm:text-base">
                {t('landing.previewSlideTitle')}
              </p>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">2 / 6</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 font-mono text-[12px] text-foreground/80">
              <span>(sin x)′ = cos x</span>
              <span className="text-ai-ink">(cos x)′ = −sin x</span>
            </div>
            <svg
              viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
              className="mt-auto w-full"
              preserveAspectRatio="none"
            >
              <line
                x1="0"
                x2={CURVE_WIDTH}
                y1={CURVE_HEIGHT / 2}
                y2={CURVE_HEIGHT / 2}
                className="stroke-border"
                strokeWidth="1"
              />
              <path
                d={COS_PATH}
                fill="none"
                className="stroke-ai"
                strokeWidth="2"
                strokeDasharray="5 4"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={SIN_PATH}
                fill="none"
                className="stroke-primary"
                strokeWidth="2.5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>

          <div className="flex flex-col gap-2.5">
            <PreviewMessage
              avatar="/avatars/teacher.png"
              name={t('landing.previewTeacher')}
              text={t('landing.previewTeacherSays')}
              tone="ai"
            />
            <PreviewMessage
              avatar="/avatars/curious.png"
              name={t('landing.previewClassmate')}
              text={t('landing.previewClassmateSays')}
              tone="peer"
            />
            <div className="mt-auto flex items-center gap-2 rounded-lg bg-correct-soft px-3 py-2 text-xs font-semibold text-correct-ink">
              <CircleCheck className="size-4 shrink-0" />
              <span className="truncate">{t('landing.previewQuiz')}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewMessage({
  avatar,
  name,
  text,
  tone,
}: {
  avatar: string;
  name: string;
  text: string;
  tone: 'ai' | 'peer';
}) {
  return (
    <div className="flex items-start gap-2">
      <img src={avatar} alt="" className="size-7 shrink-0 rounded-full bg-muted" />
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-muted-foreground">{name}</p>
        <p
          className={
            tone === 'ai'
              ? 'mt-0.5 rounded-lg rounded-tl-sm bg-ai-soft px-2.5 py-1.5 text-[12px] leading-5 text-ai-ink'
              : 'mt-0.5 rounded-lg rounded-tl-sm bg-peer-soft px-2.5 py-1.5 text-[12px] leading-5 text-peer-ink'
          }
        >
          {text}
        </p>
      </div>
    </div>
  );
}
