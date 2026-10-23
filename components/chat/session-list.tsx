'use client';

import type { ChatSession, SessionStatus } from '@/lib/types/chat';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ChevronDown, Circle, CheckCircle, Clock, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { ChatSessionComponent } from './chat-session';

interface SessionListProps {
  sessions: ChatSession[];
  expandedSessionIds: Set<string>;
  isStreaming: boolean;
  activeBubbleId?: string | null;
  onToggleExpand: (sessionId: string) => void;
  onEndSession: (sessionId: string) => Promise<void>;
  onContinueSession: (sessionId: string) => boolean;
}

const sessionBadgeStyles = {
  qa: 'bg-ai-soft text-ai-ink',
  discussion: 'bg-review-soft text-review-ink',
  lecture: 'bg-primary-soft text-primary',
};

// Labels are provided via i18n in the component

function getStatusIcon(status: SessionStatus) {
  switch (status) {
    case 'active':
      return <Circle className="size-2.5 fill-correct text-correct" />;
    case 'soft-closing':
      return <Circle className="size-2.5 fill-review text-review animate-pulse" />;
    case 'interrupted':
      return <Clock className="size-2.5 text-review" />;
    case 'completed':
      return <CheckCircle className="size-2.5 text-muted-foreground" />;
    case 'error':
      return <AlertCircle className="size-2.5 text-mistake" />;
    case 'idle':
    default:
      return <Circle className="size-2.5 text-subtle-foreground" />;
  }
}

export function SessionList({
  sessions,
  expandedSessionIds,
  isStreaming,
  activeBubbleId,
  onToggleExpand,
  onEndSession,
  onContinueSession,
}: SessionListProps) {
  const { t } = useI18n();
  return (
    <>
      {sessions.map((session) => {
        const isExpanded = expandedSessionIds.has(session.id);
        const isActive = session.status === 'active' || session.status === 'soft-closing';
        const dotColor =
          session.type === 'lecture' ? 'bg-primary' : session.type === 'qa' ? 'bg-ai' : 'bg-review';

        return (
          <div
            key={session.id}
            className={cn(
              'rounded-xl border transition-all duration-500 overflow-hidden',
              isActive
                ? 'border-primary/25 bg-primary-soft/40 shadow-sm'
                : 'border-border bg-card/50',
            )}
          >
            {/* Session Header */}
            <button
              onClick={() => onToggleExpand(session.id)}
              className="w-full flex items-center gap-1.5 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
            >
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className={cn(dotColor, 'relative inline-flex rounded-full h-2.5 w-2.5')} />
                {isActive && (
                  <span
                    className={cn(
                      dotColor,
                      'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75',
                    )}
                  />
                )}
              </span>
              <span
                className={cn(
                  'text-[8px] font-extrabold uppercase tracking-wider px-1.5 py-px rounded shrink-0',
                  sessionBadgeStyles[session.type],
                )}
              >
                {t(`chat.badge.${session.type}`)}
              </span>
              <span className="flex-1 text-[11px] font-semibold text-foreground truncate">
                {session.title}
              </span>
              <div className="flex items-center gap-1 text-[9px] text-muted-foreground">
                {getStatusIcon(session.status)}
              </div>
              <span className="text-[9px] text-muted-foreground font-medium tabular-nums shrink-0">
                {session.messages.length}
              </span>
              <ChevronDown
                className={cn(
                  'w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 shrink-0',
                  !isExpanded && '-rotate-90',
                )}
              />
            </button>

            {/* Messages */}
            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeInOut' }}
                  className="overflow-hidden border-t border-border/50"
                >
                  <div className="px-2 pb-2 pt-1">
                    <ChatSessionComponent
                      session={session}
                      isActive={isActive}
                      isStreaming={isStreaming && isActive}
                      activeBubbleId={activeBubbleId}
                      onEndSession={onEndSession}
                      onContinueSession={onContinueSession}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </>
  );
}
