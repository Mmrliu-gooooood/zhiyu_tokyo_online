'use client';

import { GraduationCap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { TeachBackView } from '@/lib/chat/teach-back-session';
import type { TeachBackPeer } from '@/lib/learning/teach-back/contracts';
import { TEACH_BACK_MAX_EXPLANATIONS } from '@/lib/learning/teach-back/contracts';

export function TeachBackEntryButton({
  enabled,
  active,
  disabled,
  onClick,
}: {
  enabled: boolean;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  if (!enabled) return null;
  return (
    <button
      type="button"
      data-testid="teach-back-entry"
      disabled={disabled}
      onClick={onClick}
      title={t('chat.teachBack.description')}
      className={cn(
        'inline-flex min-w-0 shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        active
          ? 'bg-[#356B59] text-white ring-[#356B59] dark:bg-[#7FA392] dark:ring-[#7FA392]'
          : 'bg-white text-[#356B59] ring-[#C9DED4] hover:bg-[#E7F1EC] dark:bg-gray-900 dark:text-[#9FC0B0] dark:ring-[#356B59]/50',
      )}
    >
      <GraduationCap className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{t('chat.teachBack.label')}</span>
    </button>
  );
}

export function TeachBackActivityCard({
  view,
  peers,
  topic,
  selectedPeerId,
  sceneTitle,
  preparing,
  canResumeLecture,
  needsConfirmReplace,
  onTopicChange,
  onPeerChange,
  onStart,
  onCancel,
  onRetry,
  onRestore,
  onFinish,
  onAskAgain,
}: {
  view: TeachBackView;
  peers: readonly TeachBackPeer[];
  topic: string;
  selectedPeerId: string;
  sceneTitle: string;
  preparing: boolean;
  canResumeLecture: boolean;
  needsConfirmReplace?: boolean;
  onTopicChange: (topic: string) => void;
  onPeerChange: (peerId: string) => void;
  onStart: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onRestore: () => void;
  onFinish: () => void;
  onAskAgain?: () => void;
}) {
  const { t } = useI18n();
  const activity = view.activity;
  const turn = activity?.explanations.length ?? 0;
  const statusLabel =
    view.ui === 'preparing'
      ? t('chat.teachBack.preparing')
      : view.ui === 'submitting' || view.ui === 'retrying' || view.ui === 'saving'
        ? t('chat.teachBack.evaluating')
        : view.ui === 'paused'
          ? t('chat.teachBack.paused')
          : activity?.logicalPhase === 'summary_ready' || activity?.phase === 'finished'
            ? t('chat.teachBack.summaryTitle')
            : activity?.hasStarted
              ? t('chat.teachBack.waiting', {
                  n: Math.min(turn + 1, TEACH_BACK_MAX_EXPLANATIONS),
                  max: TEACH_BACK_MAX_EXPLANATIONS,
                })
              : t('chat.teachBack.readyTitle');

  return (
    <section
      data-testid="teach-back-card"
      className="rounded-xl border border-[#C9DED4] bg-white/90 p-3 text-xs shadow-sm dark:border-[#356B59]/50 dark:bg-gray-900/80"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-[#356B59] dark:text-[#9FC0B0]">{t('chat.teachBack.label')}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{statusLabel}</p>
        </div>
        <span className="shrink-0 rounded-full bg-[#E7F1EC] px-2 py-0.5 text-[10px] text-[#356B59] dark:bg-[#356B59]/20 dark:text-[#9FC0B0]">
          {sceneTitle}
        </span>
      </div>

      {preparing && !activity?.hasStarted ? (
        <div className="mt-3 space-y-2">
          <p>{t('chat.teachBack.preparing')}</p>
          <Button type="button" size="sm" variant="secondary" onClick={onFinish}>
            {canResumeLecture ? t('chat.teachBack.endAndResume') : t('chat.teachBack.returnToClass')}
          </Button>
        </div>
      ) : null}

      {!activity?.hasStarted && !preparing ? (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] text-muted-foreground">{t('chat.teachBack.readyHint')}</p>
          <label className="block text-[11px] font-medium">
            {t('chat.teachBack.topic')}
            <input
              value={topic}
              maxLength={120}
              onChange={(event) => onTopicChange(event.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
            />
          </label>
          <label className="block text-[11px] font-medium">
            {t('chat.teachBack.peer')}
            {peers.length === 0 ? (
              <p className="mt-1 text-destructive">{t('chat.teachBack.noPeer')}</p>
            ) : (
              <select
                value={selectedPeerId}
                onChange={(event) => onPeerChange(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
              >
                {peers.map((peer) => (
                  <option key={peer.id} value={peer.id}>
                    {peer.name}
                  </option>
                ))}
              </select>
            )}
          </label>
          {needsConfirmReplace ? (
            <p role="status">{t('chat.teachBack.confirmReplace')}</p>
          ) : null}
          {view.errorCode ? (
            <p className="text-destructive" role="alert">
              {t(`chat.teachBack.errors.${view.errorCode}`)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={preparing || peers.length === 0} onClick={onStart}>
              {needsConfirmReplace ? t('chat.teachBack.confirmReplaceStart') : t('chat.teachBack.start')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              {t('chat.teachBack.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {activity?.hasStarted && view.ui === 'paused' ? (
        <div className="mt-3 space-y-2">
          <p>{t('chat.teachBack.pausedHint', { topic: activity.topic ?? '', n: turn })}</p>
          <div className="flex flex-wrap gap-2">
            {activity.logicalPhase === 'summary_ready' ? (
              <Button type="button" size="sm" onClick={onRestore}>
                {t('chat.teachBack.viewResult')}
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={onRestore}>
                {activity.logicalPhase === 'evaluation_pending'
                  ? t('chat.teachBack.retryFeedback')
                  : t('chat.teachBack.restore')}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" onClick={onFinish}>
              {t('chat.teachBack.end')}
            </Button>
          </div>
        </div>
      ) : null}

      {activity?.hasStarted && view.ui !== 'paused' ? (
        <div className="mt-3 space-y-2">
          {activity.currentQuestion ? (
            <p className="rounded-lg bg-[#E7F1EC] p-2 dark:bg-[#356B59]/20">{activity.currentQuestion.text}</p>
          ) : null}
          {activity.explanations.at(-1) ? (
            <p className="text-muted-foreground">
              {t('chat.teachBack.yourExplanation')}: {activity.explanations.at(-1)?.text}
            </p>
          ) : null}
          {view.errorCode === 'save_failed' ? (
            <p className="text-destructive" role="alert">
              {view.ui === 'saving' || activity.pendingTurnId
                ? t('chat.teachBack.errors.feedbackUnsaved')
                : t('chat.teachBack.errors.explanationUnsaved')}
            </p>
          ) : view.errorCode ? (
            <p className="text-destructive" role="alert">
              {view.errorCode === 'model_unavailable' && view.errorDetail === 'evaluation_pending'
                ? t('chat.teachBack.errors.feedbackIncomplete')
                : t(`chat.teachBack.errors.${view.errorCode}`)}
            </p>
          ) : null}
          {activity.summary ? (
            <div className="space-y-1.5" data-testid="teach-back-summary">
              <p className="font-semibold">{t('chat.teachBack.summaryTitle')}</p>
              {activity.summary.partial && activity.summary.criteria.length === 0 ? (
                <p>{t('chat.teachBack.noFeedbackYet')}</p>
              ) : (
                activity.summary.criteria.map((item) => (
                  <p key={item.criterionId}>
                    <span className="font-medium">{t(`chat.teachBack.status.${item.status}`)}</span>
                    {': '}
                    {item.reason}
                    {item.citation ? ` ${t('chat.teachBack.basedOn')} “${item.citation.excerpt}”` : ''}
                  </p>
                ))
              )}
              {activity.summary.suggestion ? <p>{activity.summary.suggestion}</p> : null}
              {activity.logicalPhase === 'summary_ready' ? (
                <p className="text-muted-foreground">{t('chat.teachBack.roundCompleteHint')}</p>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {view.errorCode && (activity.pendingTurnId || view.errorCode === 'save_failed') ? (
              <Button type="button" size="sm" onClick={onRetry}>
                {t('chat.teachBack.retry')}
              </Button>
            ) : null}
            {activity.logicalPhase === 'summary_ready' && onAskAgain ? (
              <Button
                type="button"
                size="sm"
                data-testid="teach-back-ask-again"
                disabled={view.ui === 'preparing' || view.ui === 'submitting' || view.ui === 'saving'}
                onClick={onAskAgain}
              >
                {t('chat.teachBack.askAgain')}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="secondary" onClick={onFinish}>
              {canResumeLecture ? t('chat.teachBack.endAndResume') : t('chat.teachBack.returnToClass')}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
