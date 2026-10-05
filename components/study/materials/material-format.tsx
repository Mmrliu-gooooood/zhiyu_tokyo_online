'use client';

/**
 * Small shared pieces of the study material UI (learning plan B02): parse
 * state chip, task/API error text, byte sizes and active-task polling.
 */
import { useEffect, useRef } from 'react';
import { LoaderCircle } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { StudyApiError } from '@/lib/study/spaces/client';
import type { MaterialParseState, StudyMaterialVersionView } from '@/lib/study/materials/contracts';
import type { LearningTaskView } from '@/lib/study/tasks/contracts';
import { cn } from '@/lib/utils';

const ACTIVE: MaterialParseState[] = ['queued', 'running', 'retry_wait'];

export function isParseActive(state: MaterialParseState): boolean {
  return ACTIVE.includes(state);
}

export function ParseStateChip({
  state,
  className,
}: {
  state: MaterialParseState;
  className?: string;
}) {
  const { t } = useI18n();
  const tone =
    state === 'succeeded'
      ? 'bg-primary/10 text-primary'
      : state === 'failed'
        ? 'bg-destructive/10 text-destructive'
        : isParseActive(state)
          ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          : 'bg-muted text-muted-foreground';
  return (
    <span
      data-testid="study-material-parse-state"
      data-state={state}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px]',
        tone,
        className,
      )}
    >
      {state === 'running' ? <LoaderCircle className="size-3 animate-spin" /> : null}
      {t(`study.materials.state.${state}`)}
    </span>
  );
}

const TASK_ERROR_CODES = new Set([
  'MATERIAL_NO_TEXT',
  'PARSER_FAILED',
  'MATERIAL_TYPE_UNSUPPORTED',
  'PARSER_UNAVAILABLE',
  'QUEUE_WAIT_EXPIRED',
  'WORKER_LEASE_EXPIRED',
  'EXTERNAL_RESULT_UNKNOWN',
  'MATERIAL_DELETED',
  'MATERIAL_BYTES_UNAVAILABLE',
]);

/** Why the newest parse of a version is not (yet) done, in the user's words. */
export function useTaskStatusText() {
  const { t } = useI18n();
  return (task: LearningTaskView | null): string | null => {
    if (!task) return null;
    if (task.status === 'queued' && task.queueReason && task.queueReason !== 'queued') {
      return t(`study.materials.queue.${task.queueReason}`);
    }
    if (task.status === 'failed' || task.status === 'retry_wait') {
      const code = task.lastErrorCode ?? '';
      return TASK_ERROR_CODES.has(code)
        ? t(`study.materials.taskErrors.${code}`)
        : t('study.materials.taskErrors.generic', { code: code || '—' });
    }
    return null;
  };
}

const API_ERROR_KEYS: Record<string, string> = {
  STUDY_TASKS_UNAVAILABLE: 'tasksUnavailable',
  LEARNING_TASK_OWNER_QUEUE_LIMIT: 'ownerQueueLimit',
  LEARNING_TASK_QUEUE_FULL: 'queueFull',
  STUDY_PARSER_UNAVAILABLE: 'parserUnavailable',
  STUDY_MATERIAL_TYPE_UNSUPPORTED: 'typeUnsupported',
  STUDY_MATERIAL_LIMIT: 'limit',
  STUDY_MATERIAL_VERSION_LIMIT: 'limit',
  STUDY_SPACE_MATERIAL_LIMIT: 'limit',
  STUDY_SPACE_ARCHIVED: 'spaceArchived',
  STUDY_REVISION_CONFLICT: 'conflict',
  LEARNING_TASK_NOT_RETRYABLE: 'notRetryable',
};

/** A failed material request in the user's words. */
export function useMaterialErrorText() {
  const { t } = useI18n();
  return (error: unknown): string => {
    if (error instanceof StudyApiError) {
      if (error.code === 'STUDY_UPLOAD_REJECTED') {
        const reason = error.body?.reason;
        if (reason === 'quota_exceeded') return t('study.materials.apiErrors.quota');
        if (error.status === 413) return t('study.materials.apiErrors.tooLarge');
        return t('study.materials.apiErrors.uploadFailed');
      }
      const key = API_ERROR_KEYS[error.code];
      if (key) return t(`study.materials.apiErrors.${key}`);
    }
    return t('study.errors.generic');
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "12 页 · 3,456 字" for a parsed version, or null. */
export function useArtifactStats() {
  const { t } = useI18n();
  return (version: StudyMaterialVersionView): string | null => {
    const artifact = version.artifact;
    if (!artifact) return null;
    const parts = [];
    if (artifact.pageCount > 0)
      parts.push(t('study.materials.pages', { count: artifact.pageCount }));
    parts.push(t('study.materials.chars', { count: artifact.textChars.toLocaleString() }));
    return parts.join(' · ');
  };
}

/** Re-run `refresh` every 2.5 s while `active` is true (parse in progress). */
export function usePollWhile(active: boolean, refresh: () => void): void {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => latest.current(), 2500);
    return () => clearInterval(timer);
  }, [active]);
}
