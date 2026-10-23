'use client';

import { useEffect, useRef } from 'react';
import {
  BookOpen,
  MessageSquare,
  Flashlight,
  MousePointer2,
  Play,
  Highlighter,
  SlidersHorizontal,
  StickyNote,
  Eye,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LectureNoteEntry } from '@/lib/types/chat';

const ACTION_ICON_ONLY: Record<string, { Icon: typeof Flashlight; style: string }> = {
  spotlight: {
    Icon: Flashlight,
    style: 'bg-review-soft border-review/30 text-review-ink',
  },
  laser: {
    Icon: MousePointer2,
    style: 'bg-mistake-soft border-mistake/30 text-mistake-ink',
  },
  play_video: {
    Icon: Play,
    style: 'bg-review-soft border-review/30 text-review-ink',
  },
  widget_highlight: {
    Icon: Highlighter,
    style: 'bg-review-soft border-review/30 text-review-ink',
  },
  widget_setState: {
    Icon: SlidersHorizontal,
    style: 'bg-ai-soft border-ai/30 text-ai-ink',
  },
  widget_annotation: {
    Icon: StickyNote,
    style: 'bg-ai-soft border-ai/30 text-ai-ink',
  },
  widget_reveal: {
    Icon: Eye,
    style: 'bg-correct-soft border-correct/30 text-correct-ink',
  },
};

interface LectureNotesViewProps {
  notes: LectureNoteEntry[];
  currentSceneId?: string | null;
  currentActionIndex?: number | null;
  canJumpToAction?: (sceneId: string, actionIndex: number) => boolean;
  onJumpToAction?: (sceneId: string, actionIndex: number) => void;
}

export function LectureNotesView({
  notes,
  currentSceneId,
  currentActionIndex,
  canJumpToAction,
  onJumpToAction,
}: LectureNotesViewProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the current scene note
  useEffect(() => {
    if (!currentSceneId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-scene-id="${currentSceneId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentSceneId]);

  // Empty state
  if (notes.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-6">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-soft text-primary/55 ring-1 ring-primary/25">
          <BookOpen className="w-6 h-6" />
        </div>
        <p className="text-xs font-medium text-muted-foreground">{t('chat.lectureNotes.empty')}</p>
        <p className="text-[10px] text-muted-foreground mt-1">{t('chat.lectureNotes.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 scrollbar-hide"
    >
      {notes.map((note, index) => {
        const isCurrent = note.sceneId === currentSceneId;
        const pageNum = index + 1;
        const pageLabel = t('chat.lectureNotes.pageLabel', { n: pageNum });

        return (
          <div
            key={note.sceneId}
            data-scene-id={note.sceneId}
            className={cn(
              'relative mb-3 last:mb-0 rounded-lg px-3 py-2.5 transition-colors duration-200',
              isCurrent ? 'bg-primary-soft/80 ring-1 ring-primary/25' : 'bg-muted/50',
            )}
          >
            {/* Page label row */}
            <div className="flex items-center gap-2 mb-1.5">
              {/* Timeline dot */}
              <div
                className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  isCurrent ? 'bg-primary shadow-sm shadow-primary/30' : 'bg-muted',
                )}
              />
              <span
                className={cn(
                  'text-[10px] font-semibold tracking-wide',
                  isCurrent ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                {pageLabel}
              </span>
              {isCurrent && (
                <span className="rounded-full bg-primary-soft px-1.5 py-px text-[9px] font-bold text-primary">
                  {t('chat.lectureNotes.currentPage')}
                </span>
              )}
            </div>

            {/* Scene title */}
            <h4 className="text-[13px] font-bold text-foreground mb-1.5 leading-snug pl-4">
              {note.sceneTitle}
            </h4>

            {/* Ordered items: spotlight/laser inline at sentence start, discussion as card */}
            <div className="pl-4 space-y-1">
              {(() => {
                // Build render rows: group inline actions (spotlight/laser) with next speech,
                // but render discussion as its own block
                type Row =
                  | {
                      kind: 'speech';
                      inlineActions: string[];
                      text: string;
                      actionIndex: number;
                      actionId: string;
                    }
                  | { kind: 'discussion'; label?: string; actionIndex: number; actionId: string }
                  | { kind: 'trailing'; inlineActions: string[] };
                const rows: Row[] = [];
                let pendingInline: string[] = [];
                for (const item of note.items) {
                  if (item.kind === 'action' && item.type === 'discussion') {
                    // Flush pending inline actions as trailing if any
                    if (pendingInline.length > 0) {
                      rows.push({
                        kind: 'trailing',
                        inlineActions: pendingInline,
                      });
                      pendingInline = [];
                    }
                    rows.push({
                      kind: 'discussion',
                      label: item.label,
                      actionIndex: item.actionIndex,
                      actionId: item.actionId,
                    });
                  } else if (item.kind === 'action') {
                    pendingInline.push(item.type);
                  } else {
                    rows.push({
                      kind: 'speech',
                      inlineActions: pendingInline,
                      text: item.text,
                      actionIndex: item.actionIndex,
                      actionId: item.actionId,
                    });
                    pendingInline = [];
                  }
                }
                if (pendingInline.length > 0) {
                  rows.push({ kind: 'trailing', inlineActions: pendingInline });
                }
                return rows.map((row, i) => {
                  if (row.kind === 'discussion') {
                    return (
                      <div
                        key={i}
                        className="my-1.5 flex items-start gap-1.5 rounded-md border border-review/30 bg-review-soft/60 px-2 py-1.5"
                      >
                        <MessageSquare className="w-3 h-3 text-review shrink-0 mt-0.5" />
                        <span className="text-[11px] leading-snug text-review-ink">
                          {row.label}
                        </span>
                      </div>
                    );
                  }
                  const actions = row.kind === 'trailing' ? row.inlineActions : row.inlineActions;
                  const isSpeech = row.kind === 'speech';
                  const isActiveSpeech =
                    isCurrent && isSpeech && row.actionIndex === currentActionIndex;
                  const canJump =
                    isCurrent &&
                    isSpeech &&
                    !!onJumpToAction &&
                    (canJumpToAction?.(note.sceneId, row.actionIndex) ?? false);
                  const jumpTitle = canJump
                    ? t('chat.lectureNotes.jumpToLine')
                    : t('chat.lectureNotes.jumpUnavailable');
                  const content = (
                    <>
                      {actions.map((a, j) => {
                        const cfg = ACTION_ICON_ONLY[a];
                        if (!cfg) return null;
                        const { Icon, style } = cfg;
                        return (
                          <span
                            key={j}
                            className={cn(
                              'inline-flex items-center justify-center w-4 h-4 rounded-full border align-middle mr-0.5',
                              style,
                            )}
                          >
                            <Icon className="w-2.5 h-2.5" />
                          </span>
                        );
                      })}
                      {isSpeech ? row.text : null}
                    </>
                  );
                  if (isSpeech) {
                    return (
                      <button
                        key={row.actionId}
                        type="button"
                        disabled={!canJump}
                        title={jumpTitle}
                        onClick={() => onJumpToAction?.(note.sceneId, row.actionIndex)}
                        className={cn(
                          'block w-full text-left rounded-md px-1 py-0.5 text-[12px] leading-[1.8] transition-colors',
                          isActiveSpeech ? 'bg-primary-soft text-primary-ink' : 'text-foreground',
                          canJump ? 'cursor-pointer hover:bg-primary-soft' : 'cursor-default',
                        )}
                        aria-label={jumpTitle}
                      >
                        {content}
                      </button>
                    );
                  }
                  return (
                    <p key={i} className="text-[12px] leading-[1.8] text-foreground">
                      {content}
                    </p>
                  );
                });
              })()}
            </div>
          </div>
        );
      })}
    </div>
  );
}
