'use client';

/**
 * "What's in a lesson": four tabs (slides with narration, whiteboard, quiz,
 * discussion), each with a small animated scene. Tabs advance on their own
 * while the section is on screen and stop once the visitor picks one or
 * hovers the panel; reduced motion turns the auto-advance off.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useInView, useReducedMotion } from 'motion/react';
import { Check, MessagesSquare, PenLine, Presentation, ListChecks } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'slides', icon: Presentation },
  { key: 'whiteboard', icon: PenLine },
  { key: 'quiz', icon: ListChecks },
  { key: 'discussion', icon: MessagesSquare },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const ADVANCE_MS = 7000;

export function LandingClassroomTour() {
  const { t } = useI18n();
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const inView = useInView(rootRef, { amount: 0.3 });
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState(false);
  const [hovered, setHovered] = useState(false);
  const running = inView && !picked && !hovered && !reduce;

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setActive((i) => (i + 1) % TABS.length), ADVANCE_MS);
    return () => clearTimeout(timer);
  }, [running, active]);

  const pick = (index: number) => {
    setPicked(true);
    setActive(index);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (active + delta + TABS.length) % TABS.length;
    pick(next);
    tabRefs.current[next]?.focus();
  };

  const tab = TABS[active];

  return (
    <div ref={rootRef}>
      <div
        role="tablist"
        aria-label={t('landing.tourTitle')}
        className="grid grid-cols-2 gap-2 md:grid-cols-4"
      >
        {TABS.map(({ key, icon: Icon }, index) => {
          const selected = index === active;
          return (
            <button
              key={key}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`landing-tour-tab-${key}`}
              aria-selected={selected}
              aria-controls="landing-tour-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => pick(index)}
              onKeyDown={onTabKeyDown}
              className={cn(
                'relative flex items-center gap-2 overflow-hidden rounded-xl px-3.5 py-3 text-left text-sm font-semibold transition-colors',
                selected
                  ? 'bg-card text-foreground shadow-flat'
                  : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
              )}
            >
              <Icon className={cn('size-4 shrink-0', selected && 'text-primary')} />
              <span className="truncate">{t(`landing.tour.${key}.tab`)}</span>
              {selected ? (
                <motion.span
                  key={`${active}-${running}`}
                  initial={{ scaleX: running ? 0 : 1 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: running ? ADVANCE_MS / 1000 : 0, ease: 'linear' }}
                  className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-primary"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        id="landing-tour-panel"
        role="tabpanel"
        aria-labelledby={`landing-tour-tab-${tab.key}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="mt-4 overflow-hidden rounded-3xl bg-card shadow-flat"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab.key}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25 }}
            className="grid min-h-[34rem] items-center gap-8 p-6 sm:min-h-[30rem] md:min-h-[24rem] md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] md:p-10"
          >
            <div>
              <h3 className="font-display text-2xl font-bold">
                {t(`landing.tour.${tab.key}.title`)}
              </h3>
              <p className="mt-3 text-pretty text-base leading-7 text-muted-foreground">
                {t(`landing.tour.${tab.key}.desc`)}
              </p>
            </div>
            <div aria-hidden className="select-none">
              <TourScene tab={tab.key} />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function TourScene({ tab }: { tab: TabKey }) {
  switch (tab) {
    case 'slides':
      return <SlidesScene />;
    case 'whiteboard':
      return <WhiteboardScene />;
    case 'quiz':
      return <QuizScene />;
    case 'discussion':
      return <DiscussionScene />;
  }
}

/** Fade-and-rise for a scene's parts, staggered by `delay` seconds. */
function rise(delay: number) {
  return {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.35, delay },
  };
}

function SlidesScene() {
  const { t } = useI18n();
  const bars = [0.45, 0.7, 0.55, 0.9, 0.65];
  return (
    <div className="rounded-xl bg-background p-4 shadow-flat sm:p-5">
      <motion.p {...rise(0)} className="font-display text-lg font-bold">
        {t('landing.tour.slides.sceneTitle')}
      </motion.p>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_7rem] gap-4">
        <ul className="space-y-2 text-[13px] text-muted-foreground">
          {[1, 2, 3].map((n) => (
            <motion.li key={n} {...rise(0.15 + n * 0.12)} className="flex gap-2">
              <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
              {t(`landing.tour.slides.point${n}`)}
            </motion.li>
          ))}
        </ul>
        <div className="flex h-24 items-end gap-1.5 rounded-lg bg-primary-soft/60 p-2.5">
          {bars.map((h, i) => (
            <motion.span
              key={i}
              initial={{ scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ duration: 0.5, delay: 0.4 + i * 0.08, ease: 'easeOut' }}
              style={{ height: `${h * 100}%` }}
              className="flex-1 origin-bottom rounded-sm bg-primary/80"
            />
          ))}
        </div>
      </div>
      <motion.div
        {...rise(0.7)}
        className="mt-4 flex items-center gap-2.5 rounded-lg bg-ai-soft px-3 py-2"
      >
        <img src="/avatars/teacher.png" alt="" className="size-6 rounded-full" />
        <span className="flex h-4 items-center gap-0.5">
          {Array.from({ length: 14 }, (_, i) => (
            <motion.span
              key={i}
              animate={{ scaleY: [0.3, 1, 0.45, 0.85, 0.3] }}
              transition={{ duration: 1.1, repeat: Infinity, delay: (i % 5) * 0.12 }}
              className="h-full w-0.5 origin-center rounded-full bg-ai"
            />
          ))}
        </span>
        <span className="truncate text-xs font-semibold text-ai-ink">
          {t('landing.tour.slides.narrating')}
        </span>
      </motion.div>
    </div>
  );
}

function WhiteboardScene() {
  const { t } = useI18n();
  const steps = ['a² + b² = c²', '3² + 4² = c²', '9 + 16 = 25', 'c = 5'];
  return (
    // The board keeps a fixed paper colour in both themes, like the app's whiteboard.
    <div className="rounded-xl bg-white p-4 text-slate-800 shadow-flat sm:p-5">
      <motion.p {...rise(0)} className="font-display text-lg font-bold">
        {t('landing.tour.whiteboard.sceneTitle')}
      </motion.p>
      <div className="mt-3 grid grid-cols-[minmax(0,1fr)_8.5rem] items-center gap-4">
        <div className="space-y-1.5 font-mono text-[14px]">
          {steps.map((line, i) => (
            <motion.p
              key={line}
              initial={{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }}
              animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }}
              transition={{ duration: 0.5, delay: 0.3 + i * 0.55, ease: 'easeOut' }}
              className={i === steps.length - 1 ? 'font-semibold text-[#1d4ed8]' : undefined}
            >
              {line}
            </motion.p>
          ))}
        </div>
        <svg viewBox="0 0 136 104" className="w-full">
          <motion.path
            d="M12 92 L124 92 L12 12 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.4, ease: 'easeInOut', delay: 0.2 }}
          />
          <path d="M12 80 L24 80 L24 92" fill="none" stroke="currentColor" strokeWidth="1.5" />
          {[
            { x: 64, y: 102, label: '4' },
            { x: 2, y: 56, label: '3' },
            { x: 74, y: 46, label: '5' },
          ].map(({ x, y, label }, i) => (
            <motion.text
              key={label}
              x={x}
              y={y}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.5 + i * 0.2 }}
              className="fill-current font-mono text-[11px]"
            >
              {label}
            </motion.text>
          ))}
        </svg>
      </div>
    </div>
  );
}

function QuizScene() {
  const { t } = useI18n();
  const options = ['0', '1/2', '1', '−1'];
  const answer = 2;
  const [stage, setStage] = useState<'ask' | 'chosen' | 'checked'>('ask');

  useEffect(() => {
    const chosen = setTimeout(() => setStage('chosen'), 1200);
    const checked = setTimeout(() => setStage('checked'), 2100);
    return () => {
      clearTimeout(chosen);
      clearTimeout(checked);
    };
  }, []);

  return (
    <div className="rounded-xl bg-background p-4 shadow-flat sm:p-5">
      <motion.p {...rise(0)} className="text-xs font-semibold text-review-ink">
        {t('landing.tour.quiz.sceneLabel')}
      </motion.p>
      <motion.p {...rise(0.1)} className="mt-1.5 text-[15px] font-semibold">
        {t('landing.tour.quiz.question')}
      </motion.p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {options.map((option, i) => {
          const isAnswer = i === answer;
          const chosen = isAnswer && stage !== 'ask';
          const correct = isAnswer && stage === 'checked';
          return (
            <motion.div
              key={option}
              {...rise(0.2 + i * 0.08)}
              className={cn(
                'flex items-center justify-between rounded-lg px-3 py-2 font-mono text-sm shadow-flat transition-colors duration-300',
                correct
                  ? 'bg-correct-soft text-correct-ink'
                  : chosen
                    ? 'bg-primary-soft text-primary-ink'
                    : 'bg-card',
              )}
            >
              {option}
              {correct ? <Check className="size-4" /> : null}
            </motion.div>
          );
        })}
      </div>
      <motion.p
        initial={false}
        animate={{ opacity: stage === 'checked' ? 1 : 0, y: stage === 'checked' ? 0 : 6 }}
        transition={{ duration: 0.3 }}
        className="mt-3 text-[13px] leading-6 text-correct-ink"
      >
        {t('landing.tour.quiz.feedback')}
      </motion.p>
    </div>
  );
}

function DiscussionScene() {
  const { t } = useI18n();
  const lines = [
    { avatar: '/avatars/curious.png', tone: 'peer' },
    { avatar: '/avatars/thinker.png', tone: 'review' },
    { avatar: '/avatars/teacher.png', tone: 'ai' },
  ] as const;
  const bubble = {
    peer: 'bg-peer-soft text-peer-ink',
    review: 'bg-review-soft text-review-ink',
    ai: 'bg-ai-soft text-ai-ink',
  };
  return (
    <div className="rounded-xl bg-background p-4 shadow-flat sm:p-5">
      <motion.p {...rise(0)} className="text-xs font-semibold text-muted-foreground">
        {t('landing.tour.discussion.sceneLabel')}
      </motion.p>
      <motion.p {...rise(0.1)} className="mt-1.5 text-[15px] font-semibold">
        {t('landing.tour.discussion.topic')}
      </motion.p>
      <div className="mt-3 space-y-2.5">
        {lines.map(({ avatar, tone }, i) => (
          <motion.div
            key={avatar}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.35, delay: 0.5 + i * 0.9 }}
            className="flex items-start gap-2"
          >
            <img src={avatar} alt="" className="size-7 shrink-0 rounded-full bg-muted" />
            <p
              className={cn(
                'rounded-lg rounded-tl-sm px-2.5 py-1.5 text-[13px] leading-5',
                bubble[tone],
              )}
            >
              {t(`landing.tour.discussion.line${i + 1}`)}
            </p>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
