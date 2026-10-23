'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ScanLine,
  Search,
  Globe,
  MousePointer2,
  BarChart3,
  Puzzle,
  Clapperboard,
  MessageSquare,
  Focus,
  Play,
  Maximize2,
} from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import type { SceneOutline } from '@/lib/types/generation';

// Step-specific visualizers
export function StepVisualizer({
  stepId,
  outlines,
  webSearchSources,
  onExpandOutline,
}: {
  stepId: string;
  outlines?: SceneOutline[] | null;
  webSearchSources?: Array<{ title: string; url: string }>;
  onExpandOutline?: () => void;
}) {
  switch (stepId) {
    case 'pdf-analysis':
      return <PdfScanVisualizer />;
    case 'web-search':
      return <WebSearchVisualizer sources={webSearchSources || []} />;
    case 'outline':
      return <StreamingOutlineVisualizer outlines={outlines || []} onExpand={onExpandOutline} />;
    case 'agent-generation':
      return <AgentGenerationVisualizer />;
    case 'slide-content':
      return <ContentVisualizer />;
    case 'actions':
      return <ActionsVisualizer />;
    default:
      return null;
  }
}

// PDF: Document with scanning laser line
function PdfScanVisualizer() {
  return (
    <div className="size-32 relative flex items-center justify-center">
      <motion.div
        className="absolute inset-2 bg-ai/5 rounded-2xl blur-lg"
        animate={{ opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 2, repeat: Infinity }}
      />
      <div className="w-20 h-28 bg-card rounded-lg border border-border shadow-xl relative overflow-hidden">
        <div className="p-3 space-y-2 mt-1">
          {[80, 60, 90, 45, 70].map((w, i) => (
            <motion.div
              key={i}
              className="h-1.5 bg-muted rounded"
              style={{ width: `${w}%` }}
              animate={{ opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 2, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </div>
        {/* Scanning laser */}
        <motion.div
          className="absolute inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-ai to-transparent shadow-[0_0_12px_color-mix(in_srgb,var(--ai)_60%,transparent)]"
          animate={{ top: ['5%', '90%', '5%'] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
        />
      </div>
      <motion.div
        className="absolute -top-1 -right-1"
        animate={{ rotate: [0, 10, -10, 0] }}
        transition={{ duration: 3, repeat: Infinity }}
      >
        <ScanLine className="size-6 text-ai/70" />
      </motion.div>
    </div>
  );
}

// Web Search: Miniature search engine results page with animated query + result rows
function WebSearchVisualizer({ sources }: { sources: Array<{ title: string; url: string }> }) {
  const [activeResult, setActiveResult] = useState(0);

  // Cycle through result highlight when we have sources
  useEffect(() => {
    if (sources.length === 0) return;
    const timer = setInterval(() => {
      setActiveResult((prev) => (prev + 1) % Math.min(sources.length, 4));
    }, 1400);
    return () => clearInterval(timer);
  }, [sources.length]);

  // Placeholder results for skeleton state
  const skeletonResults = [
    { titleW: 70, urlW: 45, snippetW: [90, 60] },
    { titleW: 55, urlW: 50, snippetW: [80, 75] },
    { titleW: 65, urlW: 40, snippetW: [85, 50] },
    { titleW: 50, urlW: 55, snippetW: [70, 65] },
  ];

  const ROW_H = 38;

  return (
    <div className="size-56 relative flex items-center justify-center">
      {/* Background glow */}
      <motion.div
        className="absolute inset-0 blur-3xl rounded-full bg-ai/8"
        animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 3.5, repeat: Infinity }}
      />

      {/* Search results card */}
      <div className="w-44 bg-card rounded-xl border border-border shadow-xl overflow-hidden relative">
        {/* Search bar header */}
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <Search className="size-3 text-ai shrink-0" />
          <div className="flex-1 h-4 bg-muted rounded-full overflow-hidden flex items-center px-2">
            <motion.div
              className="h-1.5 bg-ai/25 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: '70%' }}
              transition={{ duration: 0.8, ease: 'easeOut' }}
            />
          </div>
        </div>

        {/* Results list */}
        <div className="p-2 space-y-0.5 relative">
          {/* Sliding highlight */}
          {sources.length > 0 && (
            <motion.div
              className="absolute left-2 right-2 rounded-lg bg-ai/[0.06]"
              style={{ height: ROW_H - 6 }}
              animate={{ y: activeResult * ROW_H }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            />
          )}

          {sources.length === 0
            ? // Skeleton: pulsing result placeholders
              skeletonResults.map((item, i) => (
                <motion.div
                  key={i}
                  className="px-2 py-1.5 space-y-1"
                  animate={{ opacity: [0.3, 0.7, 0.3] }}
                  transition={{
                    duration: 1.4,
                    repeat: Infinity,
                    delay: i * 0.15,
                  }}
                >
                  <div
                    className="h-1.5 bg-ai-soft/40 rounded"
                    style={{ width: `${item.titleW}%` }}
                  />
                  <div className="h-1 bg-muted rounded" style={{ width: `${item.urlW}%` }} />
                  <div className="flex gap-1">
                    {item.snippetW.map((w, j) => (
                      <div
                        key={j}
                        className="h-1 bg-muted rounded"
                        style={{ width: `${w * 0.5}%` }}
                      />
                    ))}
                  </div>
                </motion.div>
              ))
            : // Live results
              sources.slice(0, 4).map((source, i) => {
                const isActive = i === activeResult;
                return (
                  <motion.div
                    key={source.url}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.08, duration: 0.25 }}
                    className="relative px-2 py-1.5 space-y-0.5"
                  >
                    <div
                      className={cn(
                        'text-[8px] font-semibold truncate transition-colors duration-300 leading-tight',
                        isActive ? 'text-ai-ink' : 'text-muted-foreground',
                      )}
                    >
                      {source.title}
                    </div>
                    <div className="text-[6px] text-ai/50 truncate leading-tight">
                      {source.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 32)}
                    </div>
                    <div className="flex gap-1">
                      <div className="h-0.5 flex-1 bg-muted rounded-full" />
                      <div className="h-0.5 w-1/3 bg-muted rounded-full" />
                    </div>
                  </motion.div>
                );
              })}
        </div>

        {/* Scanning beam */}
        <motion.div
          className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/20 dark:via-white/5 to-transparent -skew-x-12 pointer-events-none"
          initial={{ left: '-150%' }}
          animate={{ left: '200%' }}
          transition={{
            duration: 2,
            repeat: Infinity,
            repeatDelay: 2,
            ease: 'linear',
          }}
        />
      </div>

      {/* Source count badge */}
      {sources.length > 0 && (
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 15 }}
          className="absolute -top-2 -right-2 h-6 px-2 rounded-full bg-ai text-primary-foreground text-[10px] font-bold flex items-center justify-center shadow-lg shadow-ai/25 z-20 gap-0.5"
        >
          <Globe className="size-2.5" />
          {sources.length}
        </motion.div>
      )}
    </div>
  );
}

// Outline: Streams real outline data as it arrives from SSE
function StreamingOutlineVisualizer({
  outlines,
  onExpand,
}: {
  outlines: SceneOutline[];
  onExpand?: () => void;
}) {
  const { t } = useI18n();
  const isInteractive = !!onExpand;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isInteractive) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onExpand?.();
    }
  };

  return (
    <motion.div
      layoutId="outline-review-surface"
      transition={{ type: 'spring', stiffness: 220, damping: 28 }}
      // Slight tilt to suggest a tossed-down sticky note; straightens on hover.
      // Layout-shared morph into the editor surface explicitly targets rotate: 0,
      // so the rotation is interpolated as the surface grows.
      initial={isInteractive ? { rotate: -3 } : false}
      animate={isInteractive ? { rotate: -3 } : { rotate: 0 }}
      whileHover={isInteractive ? { y: -3, scale: 1.04, rotate: 0 } : undefined}
      whileTap={isInteractive ? { scale: 0.97, rotate: 0 } : undefined}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={isInteractive ? t('generation.outlineExpandHint') : undefined}
      onClick={onExpand}
      onKeyDown={handleKeyDown}
      style={{ transformOrigin: 'center center' }}
      className={cn(
        'group/outline-card relative h-52 w-44 overflow-hidden rounded-2xl border p-3 text-left',
        'bg-card/90 shadow-float backdrop-blur',
        isInteractive
          ? 'cursor-pointer border-primary/40 shadow-primary/10 transition-shadow hover:border-primary/60 hover:shadow-2xl hover:shadow-primary/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
          : 'border-border/70',
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="h-1.5 w-12 rounded-full bg-muted" />
        <motion.div
          className="size-2 rounded-full bg-primary"
          animate={{ opacity: [0.3, 1, 0.3], scale: [0.9, 1.15, 0.9] }}
          transition={{ repeat: Infinity, duration: 1.1 }}
        />
      </div>

      <div className="relative h-[168px] overflow-hidden pl-4">
        {/* Spine sits at the dot's horizontal center: pl-4 (16px) - dot offset (-15px) + dot half (4px) = 5px */}
        <div className="absolute bottom-0 left-[5px] top-0 w-px bg-muted" />
        <AnimatePresence initial={false}>
          {outlines.length === 0
            ? [58, 78, 48, 68].map((w, i) => (
                <motion.div
                  key={i}
                  className="relative mb-3"
                  animate={{ opacity: [0.35, 0.75, 0.35] }}
                  transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.16 }}
                >
                  <div className="absolute -left-[15px] top-0.5 size-2 rounded-full border border-primary/30 bg-card" />
                  <div className="h-2 rounded-full bg-muted" style={{ width: `${w}%` }} />
                  <div className="mt-1 h-1 w-2/3 rounded-full bg-muted" />
                </motion.div>
              ))
            : outlines.slice(0, 4).map((outline, i) => (
                <motion.div
                  key={outline.id}
                  layout
                  initial={{ opacity: 0, x: -10, scale: 0.96 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={{ opacity: 0, x: -10, scale: 0.96 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  className="relative mb-3"
                >
                  <div className="absolute -left-[15px] top-0.5 size-2 rounded-full border border-primary/30 bg-card shadow-sm shadow-primary/20" />
                  <div className="truncate text-[9px] font-semibold leading-tight text-foreground">
                    {i + 1}. {outline.title}
                  </div>
                  <div className="mt-1 truncate text-[7px] leading-tight text-muted-foreground">
                    {outline.description || outline.keyPoints?.[0] || '...'}
                  </div>
                </motion.div>
              ))}
        </AnimatePresence>

        {outlines.length > 4 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-[8px] font-medium text-primary/70"
          >
            +{outlines.length - 4}
          </motion.div>
        )}
      </div>

      <motion.div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-10 bg-gradient-to-t from-card via-card/80 to-transparent"
        aria-hidden
      />

      {/* Expand affordance — always visible to telegraph clickability */}
      {isInteractive && (
        <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex items-center justify-center px-2">
          <motion.span
            className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[10px] font-semibold tracking-wide text-primary-foreground shadow-lg shadow-primary/50 backdrop-blur"
            animate={{ y: [0, -1.5, 0] }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Maximize2 className="size-3" />
            {t('generation.outlineExpandHint')}
          </motion.span>
        </div>
      )}

      {/* Subtle expand icon in top-right corner — pulses gently */}
      {isInteractive && (
        <motion.div
          className="absolute right-2 top-2 z-10 flex size-5 items-center justify-center rounded-md text-primary/80 group-hover/outline-card:text-primary-ink"
          animate={{ opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
          aria-hidden
        >
          <Maximize2 className="size-3" />
        </motion.div>
      )}
    </motion.div>
  );
}

// Content: Cycles through distinct representations of Slides, Quiz, PBL, Interactive
function AgentGenerationVisualizer() {
  return (
    <div className="w-60 h-40 mx-auto flex items-center justify-center">
      <div className="flex gap-3">
        {[0, 1, 2].map((i) => (
          <motion.div
            key={i}
            className="w-14 h-20 rounded-lg bg-gradient-to-br from-peer to-primary shadow-lg"
            animate={{ y: [0, -8, 0], rotateZ: [0, 3, -3, 0] }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              delay: i * 0.3,
              ease: 'easeInOut',
            }}
          >
            <div className="w-full h-full flex items-center justify-center text-primary-foreground/80 text-lg font-bold">
              ?
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function ContentVisualizer() {
  const [index, setIndex] = useState(0);

  // 0: Slide (Blue)
  // 1: Quiz (Purple)
  // 2: PBL (Amber)
  // 3: Interactive (Emerald)
  const totalTypes = 4;

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % totalTypes);
    }, 3200);
    return () => clearInterval(timer);
  }, []);

  const variants = {
    enter: { x: 50, opacity: 0, scale: 0.9, rotateY: -15 },
    center: { x: 0, opacity: 1, scale: 1, rotateY: 0 },
    exit: { x: -50, opacity: 0, scale: 0.9, rotateY: 15 },
  };

  const getTheme = (idx: number) => {
    switch (idx) {
      case 0:
        return {
          color: 'blue',
          label: 'SLIDE',
          badge: 'bg-primary-soft text-primary-ink border-primary/30',
        };
      case 1:
        return {
          color: 'purple',
          label: 'QUIZ',
          badge: 'bg-review-soft text-review-ink border-review/30',
        };
      case 2:
        return {
          color: 'amber',
          label: 'PBL',
          badge: 'bg-peer-soft text-peer-ink border-peer/30',
        };
      case 3:
        return {
          color: 'emerald',
          label: 'WEB',
          badge: 'bg-ai-soft text-ai-ink border-ai/30',
        };
      default:
        return { color: 'blue', label: '', badge: '' };
    }
  };

  const theme = getTheme(index);

  return (
    <div className="size-56 relative flex items-center justify-center perspective-[800px]">
      {/* Background glow based on current theme */}
      <motion.div
        key={`glow-${index}`}
        className={cn(
          'absolute inset-0 blur-3xl rounded-full transition-colors duration-1000',
          theme.color === 'blue' && 'bg-primary/10',
          theme.color === 'purple' && 'bg-review/10',
          theme.color === 'amber' && 'bg-peer/10',
          theme.color === 'emerald' && 'bg-ai/10',
        )}
        animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 4, repeat: Infinity }}
      />

      {/* Subtle orbiting rings (pushed back, slower) */}
      {[0, 1].map((i) => (
        <motion.div
          key={i}
          className={cn(
            'absolute border rounded-full transition-colors duration-1000',
            theme.color === 'blue' && 'border-primary/10',
            theme.color === 'purple' && 'border-review/10',
            theme.color === 'amber' && 'border-peer/10',
            theme.color === 'emerald' && 'border-ai/10',
          )}
          style={{
            width: 180 + i * 50,
            height: 180 + i * 50,
            borderStyle: 'dashed',
          }}
          animate={{ rotate: 360 }}
          transition={{
            duration: 40 + i * 15,
            ease: 'linear',
            repeat: Infinity,
            delay: i * -5,
          }}
        />
      ))}

      {/* Main Content Container */}
      <div className="w-40 h-28 relative">
        <AnimatePresence mode="popLayout">
          <motion.div
            key={index}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: 'spring', stiffness: 80, damping: 16 }}
            className={cn(
              'absolute inset-0 bg-card rounded-xl border shadow-xl overflow-hidden flex flex-col p-3 origin-center',
              theme.color === 'blue' && 'border-primary/30',
              theme.color === 'purple' && 'border-review/30',
              theme.color === 'amber' && 'border-peer/30',
              theme.color === 'emerald' && 'border-ai/30',
            )}
          >
            {/* Consistent Badge - Now outside content logic */}
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.1 }}
              className={cn(
                'absolute top-1.5 right-1.5 z-20 px-1.5 py-0.5 rounded text-[8px] font-bold uppercase tracking-wider border backdrop-blur-md shadow-sm',
                theme.badge,
              )}
            >
              {theme.label}
            </motion.div>

            {/* --- SLIDE TYPE --- */}
            {index === 0 && (
              <div className="flex flex-col h-full pt-1">
                <motion.div
                  initial={{ width: '0%' }}
                  animate={{ width: '55%' }}
                  transition={{ delay: 0.2 }}
                  className="h-2 bg-primary/20 rounded-full mb-3 shrink-0"
                />
                <div className="flex gap-2 flex-1">
                  <div className="flex-1 space-y-2">
                    {[0.8, 0.9, 0.6, 0.7].map((w, i) => (
                      <motion.div
                        key={i}
                        initial={{ width: 0 }}
                        animate={{ width: `${w * 100}%` }}
                        transition={{ delay: 0.3 + i * 0.1 }}
                        className="h-1.5 bg-muted rounded-full"
                      />
                    ))}
                  </div>
                  <motion.div
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ delay: 0.4 }}
                    className="w-12 h-12 bg-primary-soft rounded-lg flex items-center justify-center shrink-0"
                  >
                    <BarChart3 className="size-6 text-primary/60" />
                  </motion.div>
                </div>
              </div>
            )}

            {/* --- QUIZ TYPE --- */}
            {index === 1 && (
              <div className="flex flex-col h-full justify-center space-y-2 pt-2">
                <motion.div
                  initial={{ y: -5, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.2 }}
                  className="flex justify-center mb-1"
                >
                  <div className="h-2 w-3/4 bg-peer/20 rounded-full" />
                </motion.div>

                <div className="grid grid-cols-2 gap-2">
                  {[0, 1, 2, 3].map((i) => (
                    <motion.div
                      key={i}
                      initial={{ scale: 0.8, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      transition={{ delay: 0.3 + i * 0.1 }}
                      className={cn(
                        'h-6 rounded border flex items-center px-2',
                        i === 1
                          ? 'bg-peer text-primary-foreground border-peer/60'
                          : 'bg-muted border-border',
                      )}
                    >
                      <div
                        className={cn(
                          'size-1.5 rounded-full mr-2',
                          i === 1 ? 'bg-card' : 'bg-muted',
                        )}
                      />
                      <div
                        className={cn('h-1 w-8 rounded-full', i === 1 ? 'bg-card/50' : 'bg-muted')}
                      />
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* --- PBL TYPE --- */}
            {index === 2 && (
              <div className="flex flex-col h-full pt-1">
                <div className="flex items-center gap-2 mb-2">
                  <Puzzle className="size-3 text-review shrink-0" />
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: '40%' }}
                    className="h-2 bg-review/20 rounded-full"
                  />
                </div>
                <div className="flex-1 flex gap-2 overflow-hidden">
                  {[0, 1, 2].map((col) => (
                    <motion.div
                      key={col}
                      initial={{ y: 20, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      transition={{ delay: 0.2 + col * 0.15 }}
                      className="flex-1 bg-muted rounded flex flex-col gap-1 p-1"
                    >
                      <div className="h-1 w-6 bg-muted rounded mb-1" />
                      {[0, 1].map((card) => (
                        <div
                          key={card}
                          className="h-3 w-full bg-card rounded border border-border shadow-sm"
                        />
                      ))}
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* --- INTERACTIVE TYPE --- */}
            {index === 3 && (
              <div className="flex flex-col h-full relative pt-1">
                {/* Browser Chrome - Padded right to avoid badge */}
                <div className="flex items-center gap-1 mb-2 border-b border-border pb-1 pr-10">
                  <div className="flex gap-0.5">
                    <div className="size-1.5 rounded-full bg-mistake" />
                    <div className="size-1.5 rounded-full bg-review" />
                    <div className="size-1.5 rounded-full bg-ai" />
                  </div>
                  <div className="h-1.5 flex-1 bg-muted rounded-full ml-1" />
                </div>

                <div className="flex-1 flex gap-2 relative">
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.3 }}
                    className="w-1/3 bg-muted rounded p-1 space-y-1"
                  >
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-1 w-full bg-muted rounded-full" />
                    ))}
                  </motion.div>
                  <div className="flex-1 bg-ai-soft rounded border border-ai/30 relative overflow-hidden flex items-center justify-center">
                    <Globe className="size-8 text-ai" />
                    <motion.div
                      className="absolute"
                      animate={{ x: [20, -10, 15, 0], y: [10, -15, 5, 0] }}
                      transition={{ duration: 3, ease: 'easeInOut' }}
                    >
                      <MousePointer2 className="size-3 text-ai-ink fill-ai" />
                    </motion.div>
                  </div>
                </div>
              </div>
            )}

            {/* Scanning beam (shared) */}
            <motion.div
              className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/30 dark:via-white/10 to-transparent -skew-x-12 pointer-events-none"
              initial={{ left: '-150%' }}
              animate={{ left: '200%' }}
              transition={{
                duration: 1.5,
                repeat: Infinity,
                repeatDelay: 1,
                ease: 'linear',
              }}
            />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// Actions: Timeline of speech, spotlight, and interactions being orchestrated
function ActionsVisualizer() {
  const [activeIdx, setActiveIdx] = useState(0);

  const actionItems = [
    {
      icon: MessageSquare,
      label: 'Speech',
      color: 'text-primary',
      activeBg: 'bg-primary/10',
      activeBorder: 'border-primary/30',
    },
    {
      icon: Focus,
      label: 'Spotlight',
      color: 'text-review',
      activeBg: 'bg-review/10',
      activeBorder: 'border-review/30',
    },
    {
      icon: MessageSquare,
      label: 'Speech',
      color: 'text-primary',
      activeBg: 'bg-primary/10',
      activeBorder: 'border-primary/30',
    },
    {
      icon: Play,
      label: 'Interact',
      color: 'text-ai',
      activeBg: 'bg-ai/10',
      activeBorder: 'border-ai/30',
    },
    {
      icon: MessageSquare,
      label: 'Speech',
      color: 'text-primary',
      activeBg: 'bg-primary/10',
      activeBorder: 'border-primary/30',
    },
  ];

  // Row height (py-1.5 = 6px×2 padding + icon ~16px) + gap 6px ≈ 34px per row
  const ROW_H = 34;

  useEffect(() => {
    const timer = setInterval(() => {
      setActiveIdx((prev) => (prev + 1) % actionItems.length);
    }, 1600);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="size-56 relative flex items-center justify-center">
      {/* Background pulse */}
      <motion.div
        className="absolute inset-0 blur-3xl rounded-full bg-primary/8"
        animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.5, 0.3] }}
        transition={{ duration: 3.5, repeat: Infinity }}
      />

      {/* Timeline card */}
      <div className="w-44 bg-card rounded-xl border border-border shadow-xl overflow-hidden relative">
        {/* Header */}
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <Clapperboard className="size-3 text-primary" />
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: '50%' }}
            transition={{ delay: 0.2 }}
            className="h-1.5 bg-primary/20 rounded-full"
          />
        </div>

        {/* Action items */}
        <div className="p-2 space-y-1.5 relative">
          {/* Sliding highlight — absolute, animates via y transform, no layout impact */}
          <motion.div
            className="absolute left-2 right-2 rounded-lg bg-primary/[0.06]"
            style={{ height: ROW_H - 6 }}
            animate={{ y: activeIdx * ROW_H }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
          />

          {actionItems.map((item, i) => {
            const Icon = item.icon;
            const isActive = i === activeIdx;
            const isPast = i < activeIdx;
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: isPast ? 0.4 : 1, x: 0 }}
                transition={{ delay: 0.1 + i * 0.08, duration: 0.3 }}
                className="relative flex items-center gap-2 px-2 py-1.5 rounded-lg"
              >
                <div
                  className={cn(
                    'size-4 rounded flex items-center justify-center shrink-0 transition-colors duration-300',
                    isActive ? item.color : 'text-subtle-foreground',
                  )}
                >
                  <Icon className="size-3" />
                </div>
                <div className="flex-1 flex items-center gap-1.5">
                  <span
                    className={cn(
                      'text-[8px] font-semibold uppercase tracking-wider transition-colors duration-300',
                      isActive ? item.color : 'text-muted-foreground',
                    )}
                  >
                    {item.label}
                  </span>
                  <div
                    className={cn(
                      'h-1 flex-1 rounded-full transition-colors duration-300',
                      isActive ? 'bg-current opacity-20' : 'bg-muted',
                    )}
                  />
                </div>
                {/* Pulsing dot — always rendered, opacity-controlled, no layout shift */}
                <motion.div
                  className="size-1.5 rounded-full bg-primary"
                  animate={{ opacity: isActive ? [1, 0.3, 1] : 0 }}
                  transition={isActive ? { duration: 0.8, repeat: Infinity } : { duration: 0.2 }}
                />
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
