'use client';

/**
 * The landing hero's illustration, played as a short scene: a request is
 * typed into the composer, sent, and becomes a classroom — the slide's curves
 * draw in, the teacher answers, a classmate asks, a quiz appears. It replays
 * while on screen. Built from the app's own tokens so it follows the theme;
 * purely decorative for screen readers.
 */
import { useEffect, useRef, useState } from 'react';
import { motion, useInView, useReducedMotion } from 'motion/react';
import { ArrowUp, CircleCheck } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

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

/** Scene beats after the request is sent (ms): slide, teacher typing, … */
const BEATS = [0, 1300, 2000, 2900, 3600, 4400] as const;
const LAST_BEAT = BEATS.length;
/** How long the finished scene stays before it replays (ms). */
const HOLD_MS = 6500;

export function LandingClassroomPreview() {
  const rootRef = useRef<HTMLDivElement>(null);
  const inView = useInView(rootRef, { amount: 0.35 });
  const [run, setRun] = useState(0);

  return (
    <div ref={rootRef} aria-hidden className="relative select-none">
      <PreviewScene key={run} active={inView} onDone={() => setRun((n) => n + 1)} />
    </div>
  );
}

function PreviewScene({ active, onDone }: { active: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const reduce = useReducedMotion();
  const prompt = t('landing.previewPrompt');
  const [typed, setTyped] = useState(0);
  // 0 = typing; 1 = sent, slide; 2/3 = teacher typing/says; 4/5 = classmate; 6 = quiz
  const [beat, setBeat] = useState(0);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (!active) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    if (reduce) {
      later(0, () => {
        setTyped(prompt.length);
        setBeat(LAST_BEAT);
      });
      return () => timers.forEach(clearTimeout);
    }
    // Values only move forward, so scrolling away and back resumes the scene.
    const step = Math.max(28, Math.min(70, 1500 / prompt.length));
    for (let i = 1; i <= prompt.length; i += 1) {
      later(400 + i * step, () => setTyped((n) => Math.max(n, i)));
    }
    const sent = 400 + prompt.length * step + 350;
    BEATS.forEach((offset, index) => {
      later(sent + offset, () => setBeat((b) => Math.max(b, index + 1)));
    });
    later(sent + BEATS[BEATS.length - 1] + HOLD_MS, () => onDoneRef.current());
    return () => timers.forEach(clearTimeout);
  }, [active, reduce, prompt]);

  const shown = (from: number) => ({
    opacity: beat >= from ? 1 : 0,
    y: beat >= from ? 0 : 8,
  });

  return (
    <>
      {/* The request, as typed into the composer */}
      <div className="relative z-10 mx-3 -mb-7 rounded-xl bg-card p-3 shadow-float sm:mx-8">
        <p className="relative text-[13px] leading-6 text-foreground sm:text-sm">
          <span className="invisible">{prompt}</span>
          <span className="absolute inset-0">
            {prompt.slice(0, typed)}
            {beat === 0 ? (
              <span className="ml-px inline-block h-[1.1em] w-px translate-y-[0.2em] animate-pulse bg-primary" />
            ) : null}
          </span>
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
          <motion.span
            animate={beat === 1 ? { scale: [1, 0.82, 1] } : { scale: 1 }}
            transition={{ duration: 0.35 }}
            className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-edge-primary"
          >
            <ArrowUp className="size-4" />
          </motion.span>
        </div>
      </div>

      {/* The classroom it becomes */}
      <div className="overflow-hidden rounded-3xl bg-card shadow-feature">
        <div className="grid grid-cols-1 gap-3 p-3 pt-10 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] sm:p-4 sm:pt-11">
          <div className="relative flex aspect-video flex-col overflow-hidden rounded-xl bg-background p-3.5 shadow-flat sm:p-4">
            {/* Skeleton while the lesson is being prepared */}
            <motion.div
              initial={false}
              animate={{ opacity: beat >= 1 ? 0 : 1 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 flex flex-col gap-2 p-3.5 sm:p-4"
            >
              <span className="h-4 w-2/5 animate-pulse rounded bg-muted" />
              <span className="h-3 w-3/5 animate-pulse rounded bg-muted" />
              <span className="mt-auto h-1/2 w-full animate-pulse rounded-lg bg-muted/70" />
            </motion.div>
            <motion.div
              initial={false}
              animate={shown(1)}
              transition={{ duration: 0.4 }}
              className="flex flex-1 flex-col"
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate font-display text-[15px] font-bold text-foreground sm:text-base">
                  {t('landing.previewSlideTitle')}
                </p>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  2 / 6
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 font-mono text-[12px] text-foreground/80">
                <span>(sin x)′ = cos x</span>
                <motion.span
                  initial={false}
                  animate={{ opacity: beat >= 3 ? 1 : 0 }}
                  transition={{ duration: 0.4 }}
                  className="text-ai-ink"
                >
                  (cos x)′ = −sin x
                </motion.span>
              </div>
              <svg
                viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
                className="mt-auto w-full"
                preserveAspectRatio="none"
              >
                <defs>
                  <clipPath id="landing-curve-reveal">
                    <motion.rect
                      x="0"
                      y="0"
                      height={CURVE_HEIGHT}
                      initial={{ width: 0 }}
                      animate={{ width: beat >= 1 ? CURVE_WIDTH : 0 }}
                      transition={{ duration: 1.6, ease: 'easeInOut', delay: 0.2 }}
                    />
                  </clipPath>
                </defs>
                <line
                  x1="0"
                  x2={CURVE_WIDTH}
                  y1={CURVE_HEIGHT / 2}
                  y2={CURVE_HEIGHT / 2}
                  className="stroke-border"
                  strokeWidth="1"
                />
                <g clipPath="url(#landing-curve-reveal)">
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
                </g>
              </svg>
            </motion.div>
            {/* Narration progress */}
            <motion.span
              initial={{ width: '0%' }}
              animate={{ width: beat >= 1 ? '64%' : '0%' }}
              transition={{ duration: 5, ease: 'linear' }}
              className="absolute bottom-0 left-0 h-0.5 bg-primary/60"
            />
          </div>

          <div className="relative flex flex-col gap-2.5">
            <motion.div
              initial={false}
              animate={{ opacity: beat >= 2 ? 0 : 1 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-x-0 top-0 space-y-3"
            >
              {[0, 1].map((row) => (
                <div key={row} className="flex items-start gap-2">
                  <span className="size-7 shrink-0 animate-pulse rounded-full bg-muted" />
                  <span className="flex flex-1 flex-col gap-1.5 pt-0.5">
                    <span className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
                    <span className="h-8 w-full animate-pulse rounded-lg bg-muted/70" />
                  </span>
                </div>
              ))}
            </motion.div>
            <PreviewMessage
              avatar="/avatars/teacher.png"
              name={t('landing.previewTeacher')}
              text={t('landing.previewTeacherSays')}
              tone="ai"
              visible={beat >= 2}
              typing={beat === 2}
            />
            <PreviewMessage
              avatar="/avatars/curious.png"
              name={t('landing.previewClassmate')}
              text={t('landing.previewClassmateSays')}
              tone="peer"
              visible={beat >= 4}
              typing={beat === 4}
            />
            <motion.div
              initial={false}
              animate={{ ...shown(6), scale: beat >= 6 ? 1 : 0.96 }}
              transition={{ type: 'spring', stiffness: 380, damping: 24 }}
              className="mt-auto flex items-center gap-2 rounded-lg bg-correct-soft px-3 py-2 text-xs font-semibold text-correct-ink"
            >
              <CircleCheck className="size-4 shrink-0" />
              <span className="truncate">{t('landing.previewQuiz')}</span>
            </motion.div>
          </div>
        </div>
      </div>
    </>
  );
}

function PreviewMessage({
  avatar,
  name,
  text,
  tone,
  visible,
  typing,
}: {
  avatar: string;
  name: string;
  text: string;
  tone: 'ai' | 'peer';
  visible: boolean;
  typing: boolean;
}) {
  return (
    <motion.div
      initial={false}
      animate={{ opacity: visible ? 1 : 0, y: visible ? 0 : 8 }}
      transition={{ duration: 0.3 }}
      className="flex items-start gap-2"
    >
      <img src={avatar} alt="" className="size-7 shrink-0 rounded-full bg-muted" />
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-muted-foreground">{name}</p>
        <p
          className={cn(
            'relative mt-0.5 rounded-lg rounded-tl-sm px-2.5 py-1.5 text-[12px] leading-5',
            tone === 'ai' ? 'bg-ai-soft text-ai-ink' : 'bg-peer-soft text-peer-ink',
          )}
        >
          {/* The text keeps its space while the typing dots show. */}
          <span className={typing ? 'invisible' : undefined}>{text}</span>
          {typing ? (
            <span className="absolute left-2.5 top-1/2 flex -translate-y-1/2 gap-1">
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }}
                  className="size-1.5 rounded-full bg-current"
                />
              ))}
            </span>
          ) : null}
        </p>
      </div>
    </motion.div>
  );
}
