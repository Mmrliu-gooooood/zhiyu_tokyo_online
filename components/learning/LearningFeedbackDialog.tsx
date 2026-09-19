'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Loader2, MessageCircle, RefreshCw } from 'lucide-react';

import { LearningCheckForm } from './LearningCheckForm';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getCurrentModelConfig } from '@/lib/utils/model-config';
import { createLearningContentSnapshot } from '@/lib/learning/content-snapshot';
import type {
  LearningCheckPayloadV1,
  LearningCheckResponse,
  LearningContentSnapshot,
} from '@/lib/learning/contracts';
import { getLearningCheckReadiness } from '@/lib/learning/readiness';
import {
  buildLearningRemediationContext,
  createRemediationCheckPlan,
  materializeRemediationCheckDraft,
  resolveRemediationReviewTarget,
  type RemediationContext,
} from '@/lib/learning/remediation';
import { projectLearningFeedback, type LearningFeedbackReport } from '@/lib/learning/report';
import {
  listLearningCheckAttempts,
  saveLearningCheckQuestionSet,
  type StoredLearningCheckAttempt,
} from '@/lib/learning/runtime';
import { useStageStore } from '@/lib/store';
import type { Scene, Stage } from '@/lib/types/stage';
import { TeachBackHistory } from '@/components/learning/teach-back/TeachBackHistory';
import type { TeachBackProjectedActivity } from '@/lib/learning/teach-back/activity';

interface LearningCheckApiBody {
  success?: unknown;
  questionSet?: unknown;
  coverage?: unknown;
  review?: unknown;
  generation?: unknown;
  error?: unknown;
}

function learningHeaders(): Record<string, string> {
  const model = getCurrentModelConfig();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-model': model.source === 'platform' ? '' : model.modelString,
    'x-api-key': model.source === 'platform' ? '' : model.apiKey,
    'x-model-source': model.source,
  };
  if (model.source === 'platform' && model.defaultId) {
    headers['x-platform-default-id'] = model.defaultId;
  }
  if (model.baseUrl) headers['x-base-url'] = model.baseUrl;
  if (model.providerType) headers['x-provider-type'] = model.providerType;
  return headers;
}

async function postLearningCheck(input: {
  requestId: string;
  scope: 'course' | 'remediation';
  snapshot: LearningContentSnapshot;
  focus?: { conceptId: string; priorQuestionPrompt: string };
  language?: string;
  signal?: AbortSignal;
}): Promise<LearningCheckResponse> {
  const response = await fetch('/api/learning/check', {
    method: 'POST',
    headers: learningHeaders(),
    signal: input.signal,
    body: JSON.stringify({
      requestId: input.requestId,
      scope: input.scope,
      snapshot: input.snapshot,
      ...(input.focus ? { focus: input.focus } : {}),
      ...(input.language ? { language: input.language } : {}),
    }),
  });
  const body = (await response.json().catch(() => null)) as LearningCheckApiBody | null;
  if (!response.ok || body?.success !== true) {
    throw new Error(typeof body?.error === 'string' ? body.error : 'learning-check-failed');
  }
  return {
    questionSet: body.questionSet as LearningCheckResponse['questionSet'],
    coverage: body.coverage as LearningCheckResponse['coverage'],
    review: body.review as LearningCheckResponse['review'],
    generation: body.generation as LearningCheckResponse['generation'],
  };
}

type ValidateLearningCheckBeforePersist = (
  stageId: string,
  snapshot: LearningContentSnapshot,
) => boolean | Promise<boolean>;

interface CurrentLearningSnapshotState {
  stage: Pick<Stage, 'id' | 'name'> | null;
  scenes: readonly Scene[];
}

export async function validateLearningSnapshotBeforePersist(
  stageId: string,
  snapshot: LearningContentSnapshot,
  dependencies: {
    readCurrent?: () => CurrentLearningSnapshotState;
    buildSnapshot?: typeof createLearningContentSnapshot;
  } = {},
): Promise<boolean> {
  const readCurrent =
    dependencies.readCurrent ??
    (() => {
      const current = useStageStore.getState();
      return { stage: current.stage, scenes: current.scenes };
    });
  const current = readCurrent();
  if (!current.stage || current.stage.id !== stageId) return false;
  const rebuilt = await (dependencies.buildSnapshot ?? createLearningContentSnapshot)({
    courseTitle: current.stage.name,
    scenes: current.scenes,
  });
  const latest = readCurrent();
  return (
    latest.stage?.id === stageId &&
    latest.stage.name === current.stage.name &&
    latest.scenes === current.scenes &&
    rebuilt.contentRevision === snapshot.contentRevision
  );
}

function staleLearningCheckError(): Error {
  const error = new Error('Learning-check source changed before persistence');
  error.name = 'AbortError';
  return error;
}

export async function generateAndPersistLearningCheck(input: {
  stageId: string;
  requestId: string;
  checkId: string;
  attemptId: string;
  snapshot: LearningContentSnapshot;
  language?: string;
  signal?: AbortSignal;
  post?: typeof postLearningCheck;
  persist?: typeof saveLearningCheckQuestionSet;
  validateBeforePersist: ValidateLearningCheckBeforePersist;
  now?: () => string;
}): Promise<LearningCheckPayloadV1> {
  const result = await (input.post ?? postLearningCheck)({
    requestId: input.requestId,
    scope: 'course',
    snapshot: input.snapshot,
    language: input.language,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  const payload: LearningCheckPayloadV1 = {
    payloadVersion: 1,
    identity: {
      checkId: input.checkId,
      attemptId: input.attemptId,
      source: 'course_check',
      requestId: input.requestId,
    },
    source: input.snapshot,
    questionSet: result.questionSet,
    lifecycle: {
      phase: 'draft',
      answers: {},
      grading: {},
      startedAt: (input.now ?? (() => new Date().toISOString()))(),
    },
    generation: result.generation,
  };
  if (!(await input.validateBeforePersist(input.stageId, input.snapshot))) {
    throw staleLearningCheckError();
  }
  input.signal?.throwIfAborted();
  await (input.persist ?? saveLearningCheckQuestionSet)(input.stageId, payload);
  return payload;
}

export async function generateAndPersistRemediationCheck(input: {
  stageId: string;
  context: RemediationContext;
  snapshot: LearningContentSnapshot;
  requestId: string;
  checkId: string;
  attemptId: string;
  language?: string;
  signal?: AbortSignal;
  post?: typeof postLearningCheck;
  persist?: typeof saveLearningCheckQuestionSet;
  validateBeforePersist: ValidateLearningCheckBeforePersist;
  now?: () => string;
}): Promise<LearningCheckPayloadV1> {
  const plan = createRemediationCheckPlan(input.context, input.snapshot, {
    requestId: input.requestId,
    checkId: input.checkId,
    attemptId: input.attemptId,
  });
  const response = await (input.post ?? postLearningCheck)({
    ...plan.request,
    language: input.language,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  const payload = materializeRemediationCheckDraft(plan, response, input.now);
  if (!(await input.validateBeforePersist(input.stageId, input.snapshot))) {
    throw staleLearningCheckError();
  }
  input.signal?.throwIfAborted();
  await (input.persist ?? saveLearningCheckQuestionSet)(input.stageId, payload);
  return payload;
}

export function selectResumableLearningCheck(
  attempts: readonly StoredLearningCheckAttempt[],
): LearningCheckPayloadV1 | undefined {
  return [...attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.status === 'active' &&
        (attempt.payload.lifecycle.phase === 'draft' ||
          attempt.payload.lifecycle.phase === 'submitted'),
    )?.payload;
}

export function isCurrentLearningFeedbackRefresh(input: {
  requestEpoch: number;
  currentEpoch: number;
  requestStageId: string;
  currentStageId: string;
  open: boolean;
}): boolean {
  return (
    input.open &&
    input.requestEpoch === input.currentEpoch &&
    input.requestStageId === input.currentStageId
  );
}

export function isCurrentLearningFeedbackSnapshot(input: {
  snapshotStageId: string | undefined;
  currentStageId: string;
}): boolean {
  return input.snapshotStageId === input.currentStageId;
}

export interface LearningFeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stage: Stage;
  scenes: readonly Scene[];
  onReviewScene?: (sceneId: string) => Promise<unknown> | unknown;
  onDiscussQuestion?: (context: RemediationContext, prompt: string) => Promise<unknown> | unknown;
  onBeforeAnswer?: () => Promise<unknown> | unknown;
  showChecks?: boolean;
  showTeachBack?: boolean;
  onRestoreTeachBack?: (activity: TeachBackProjectedActivity) => void;
}

export function LearningFeedbackDialog({
  open,
  onOpenChange,
  stage,
  scenes,
  onReviewScene,
  onDiscussQuestion,
  onBeforeAnswer,
  showChecks = true,
  showTeachBack = false,
  onRestoreTeachBack,
}: LearningFeedbackDialogProps) {
  const { locale, t } = useI18n();
  const [snapshot, setSnapshot] = useState<LearningContentSnapshot>();
  const [report, setReport] = useState<LearningFeedbackReport>();
  const [storedAttempts, setStoredAttempts] = useState<StoredLearningCheckAttempt[]>([]);
  const [active, setActive] = useState<LearningCheckPayloadV1>();
  const [expandedEvidence, setExpandedEvidence] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestEpoch = useRef(0);
  const requestAbort = useRef<AbortController | undefined>(undefined);
  const snapshotStageId = useRef<string | undefined>(undefined);
  const refreshScope = useRef({ open, stageId: stage.id });
  refreshScope.current = { open, stageId: stage.id };

  const refresh = useCallback(async () => {
    if (!showChecks) return;
    const epoch = ++requestEpoch.current;
    const requestStageId = stage.id;
    const nextSnapshot = await createLearningContentSnapshot({
      courseTitle: stage.name,
      scenes,
    });
    const attempts = await listLearningCheckAttempts(requestStageId);
    if (
      !isCurrentLearningFeedbackRefresh({
        requestEpoch: epoch,
        currentEpoch: requestEpoch.current,
        requestStageId,
        currentStageId: refreshScope.current.stageId,
        open: refreshScope.current.open,
      })
    ) {
      return;
    }
    snapshotStageId.current = requestStageId;
    setSnapshot(nextSnapshot);
    setStoredAttempts(attempts);
    setReport(projectLearningFeedback(attempts, nextSnapshot.contentRevision));
    setActive(selectResumableLearningCheck(attempts));
  }, [scenes, showChecks, stage.id, stage.name]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    setError(undefined);
    void refresh()
      .catch(() => {
        if (current) setError(t('learningFeedback.loadFailed'));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      requestEpoch.current += 1;
    };
  }, [open, refresh, t]);

  useEffect(() => {
    requestAbort.current?.abort();
    requestAbort.current = undefined;
    setActive(undefined);
    return () => {
      requestAbort.current?.abort();
    };
  }, [open, stage.id]);

  useEffect(() => {
    if (open && active) void onBeforeAnswer?.();
  }, [active, onBeforeAnswer, open]);

  const start = async () => {
    const state = useStageStore.getState();
    const readiness = getLearningCheckReadiness({
      generationComplete: state.generationComplete,
      generationStatus: state.generationStatus,
      outlineProducer: state.outlineProducer,
      scenes: state.scenes,
      outlines: state.outlines,
      generatingOutlines: state.generatingOutlines,
      failedOutlines: state.failedOutlines,
    });
    if (!readiness.ready) {
      setError(t('learningFeedback.generationIncomplete'));
      return;
    }
    setLoading(true);
    setError(undefined);
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    const epoch = ++requestEpoch.current;
    try {
      const currentSnapshot = isCurrentLearningFeedbackSnapshot({
        snapshotStageId: snapshotStageId.current,
        currentStageId: stage.id,
      })
        ? snapshot!
        : await createLearningContentSnapshot({ courseTitle: stage.name, scenes });
      const suffix = crypto.randomUUID();
      const payload = await generateAndPersistLearningCheck({
        stageId: stage.id,
        requestId: `learning-request:${suffix}`,
        checkId: `learning-check:${suffix}`,
        attemptId: `learning-attempt:${suffix}`,
        snapshot: currentSnapshot,
        language: locale,
        signal: controller.signal,
        validateBeforePersist: validateLearningSnapshotBeforePersist,
      });
      if (requestEpoch.current !== epoch || useStageStore.getState().stage?.id !== stage.id) {
        return;
      }
      snapshotStageId.current = stage.id;
      setSnapshot(currentSnapshot);
      setActive(payload);
    } catch {
      if (requestEpoch.current === epoch && !controller.signal.aborted) {
        setError(t('learningFeedback.generateFailed'));
      }
    } finally {
      if (requestEpoch.current === epoch) setLoading(false);
    }
  };

  const startRemediation = async (context: RemediationContext) => {
    if (
      !snapshot ||
      !isCurrentLearningFeedbackSnapshot({
        snapshotStageId: snapshotStageId.current,
        currentStageId: stage.id,
      })
    ) {
      return;
    }
    setLoading(true);
    setError(undefined);
    requestAbort.current?.abort();
    const controller = new AbortController();
    requestAbort.current = controller;
    const epoch = ++requestEpoch.current;
    try {
      const suffix = crypto.randomUUID();
      const payload = await generateAndPersistRemediationCheck({
        stageId: stage.id,
        context,
        snapshot,
        requestId: `remediation-request:${suffix}`,
        checkId: `remediation-check:${suffix}`,
        attemptId: `remediation-attempt:${suffix}`,
        language: locale,
        signal: controller.signal,
        validateBeforePersist: validateLearningSnapshotBeforePersist,
      });
      if (requestEpoch.current !== epoch || useStageStore.getState().stage?.id !== stage.id) return;
      setActive(payload);
    } catch {
      if (requestEpoch.current === epoch && !controller.signal.aborted) {
        setError(t('learningFeedback.remediationGenerateFailed'));
      }
    } finally {
      if (requestEpoch.current === epoch) setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(88vh,760px)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('learningFeedback.title')}</DialogTitle>
          <DialogDescription>{t('learningFeedback.description')}</DialogDescription>
        </DialogHeader>
        {showTeachBack ? (
          <TeachBackHistory
            stageId={stage.id}
            enabled={showTeachBack}
            onRestore={
              onRestoreTeachBack
                ? (activity) => {
                    onOpenChange(false);
                    onRestoreTeachBack(activity);
                  }
                : undefined
            }
          />
        ) : null}
        {loading && showChecks ? (
          <div className="flex min-h-32 items-center justify-center" aria-live="polite">
            <Loader2 className="animate-spin" />
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : active ? (
          <LearningCheckForm
            stageId={stage.id}
            payload={active}
            onReviewed={async () => {
              setActive(undefined);
              await refresh();
            }}
          />
        ) : (
          <div className="space-y-4">
            {error ? (
              <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            {showChecks && report?.status === 'none' ? (
              <p className="text-sm text-muted-foreground">{t('learningFeedback.none')}</p>
            ) : null}
            {showChecks && report && report.status !== 'none' ? (
              <div className="space-y-3">
                {[...report.attempts].reverse().map((attempt) => (
                  <article key={attempt.attemptId} className="rounded-xl border border-border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-semibold">
                        {t('learningFeedback.version', { id: attempt.questionSetId })}
                      </h3>
                      <span className="text-xs text-muted-foreground">
                        {attempt.oldContentVersion
                          ? t('learningFeedback.oldVersion')
                          : t('learningFeedback.currentVersion')}
                      </span>
                    </div>
                    <time className="mt-1 block text-xs text-muted-foreground">
                      {new Date(attempt.updatedAt).toLocaleString(locale)}
                    </time>
                    <p className="mt-2 text-sm">
                      {attempt.status === 'complete'
                        ? t('learningFeedback.completeScore', {
                            earned: attempt.earnedPoints,
                            possible: attempt.fullPossiblePoints,
                            percent: attempt.finalPercent,
                          })
                        : attempt.status === 'draft'
                          ? t('learningFeedback.draft')
                          : t('learningFeedback.partialScore', {
                              graded: attempt.gradedCount,
                              total: attempt.questions.length,
                              earned: attempt.earnedPoints,
                              pending: attempt.pendingCount,
                            })}
                    </p>
                    <div className="mt-3 space-y-2">
                      {attempt.questions.map((question) => {
                        const stored = storedAttempts.find(
                          (candidate) => candidate.payload.identity.attemptId === attempt.attemptId,
                        );
                        const context = stored
                          ? buildLearningRemediationContext(stored.payload, question.questionId)
                          : undefined;
                        const reviewTarget =
                          context && snapshot
                            ? resolveRemediationReviewTarget(context, {
                                currentContentRevision: snapshot.contentRevision,
                                availableSceneIds: new Set(scenes.map((scene) => scene.id)),
                              })
                            : undefined;
                        const actionKey = `${attempt.attemptId}:${question.questionId}`;
                        const parentQuestion =
                          attempt.source === 'remediation_check' &&
                          attempt.parentAttemptId &&
                          attempt.parentQuestionId
                            ? report.attempts
                                .find(
                                  (candidate) => candidate.attemptId === attempt.parentAttemptId,
                                )
                                ?.questions.find(
                                  (candidate) => candidate.questionId === attempt.parentQuestionId,
                                )
                            : undefined;
                        const canCheck =
                          Boolean(context?.conceptId && context.sourceRefs.length > 0) &&
                          !attempt.oldContentVersion;
                        return (
                          <div
                            key={question.questionId}
                            className="rounded-lg bg-muted/50 p-3 text-sm"
                          >
                            <p className="font-medium">{question.prompt}</p>
                            <p className="mt-1 text-muted-foreground">
                              {question.grade.status === 'graded'
                                ? t('learningFeedback.questionScore', {
                                    earned: question.grade.score,
                                    possible: question.maxScore,
                                  })
                                : t('learningFeedback.pending')}
                            </p>
                            <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
                              <div>
                                <dt className="inline font-medium">
                                  {t('learningFeedback.answer')}:{' '}
                                </dt>
                                <dd className="inline">
                                  {Array.isArray(question.studentAnswer)
                                    ? question.studentAnswer.join(', ')
                                    : question.studentAnswer || '—'}
                                </dd>
                              </div>
                              <div>
                                <dt className="inline font-medium">
                                  {t('learningFeedback.scoringGuide')}:{' '}
                                </dt>
                                <dd className="inline">{question.scoringGuide}</dd>
                              </div>
                              <div>
                                <dt className="inline font-medium">
                                  {t('learningFeedback.concept')}:{' '}
                                </dt>
                                <dd className="inline">{question.conceptId}</dd>
                              </div>
                              <div>
                                <dt className="inline font-medium">
                                  {t('learningFeedback.source')}:{' '}
                                </dt>
                                <dd className="inline">{question.sourceRefs.join(', ')}</dd>
                              </div>
                            </dl>
                            {question.grade.status === 'graded' ? (
                              <p className="mt-2 text-xs">{question.grade.comment}</p>
                            ) : question.grade.status === 'error' ? (
                              <p className="mt-2 text-xs text-destructive">
                                {t('learningFeedback.gradingError')}
                              </p>
                            ) : null}
                            {question.recommendation ? (
                              <p className="mt-1">
                                {t('learningFeedback.recommendationReviewSource')}
                              </p>
                            ) : null}
                            {parentQuestion ? (
                              <div className="mt-3 rounded-md border border-border bg-background p-3 text-xs">
                                <p className="font-medium">
                                  {t('learningFeedback.remediationForQuestion', {
                                    question: parentQuestion.prompt,
                                  })}
                                </p>
                                <p className="mt-1 text-muted-foreground">
                                  {t('learningFeedback.originalAnswer')}:{' '}
                                  {Array.isArray(parentQuestion.studentAnswer)
                                    ? parentQuestion.studentAnswer.join(', ')
                                    : parentQuestion.studentAnswer || '—'}
                                </p>
                                <p className="mt-1 text-muted-foreground">
                                  {t('learningFeedback.followUpAnswer')}:{' '}
                                  {Array.isArray(question.studentAnswer)
                                    ? question.studentAnswer.join(', ')
                                    : question.studentAnswer || '—'}
                                </p>
                              </div>
                            ) : null}
                            {context ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => {
                                    if (reviewTarget?.kind === 'scene' && onReviewScene) {
                                      onOpenChange(false);
                                      void Promise.resolve(
                                        onReviewScene(reviewTarget.sceneId),
                                      ).catch(() => undefined);
                                      return;
                                    }
                                    setExpandedEvidence((current) =>
                                      current === actionKey ? undefined : actionKey,
                                    );
                                  }}
                                >
                                  <BookOpen />
                                  {reviewTarget?.label === 'explanation'
                                    ? t('learningFeedback.reviewExplanation')
                                    : t('learningFeedback.reviewQuestion')}
                                </Button>
                                {onDiscussQuestion ? (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                      void Promise.resolve(
                                        onDiscussQuestion(
                                          context,
                                          t('learningFeedback.discussPrompt'),
                                        ),
                                      )
                                        .then(() => onOpenChange(false))
                                        .catch(() => setError(t('learningFeedback.actionFailed')));
                                    }}
                                  >
                                    <MessageCircle />
                                    {t('learningFeedback.discussQuestion')}
                                  </Button>
                                ) : null}
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={!canCheck}
                                  title={
                                    canCheck
                                      ? undefined
                                      : t('learningFeedback.remediationUnavailable')
                                  }
                                  onClick={() => void startRemediation(context)}
                                >
                                  <RefreshCw />
                                  {t('learningFeedback.checkQuestion')}
                                </Button>
                              </div>
                            ) : null}
                            {expandedEvidence === actionKey && context ? (
                              <div className="mt-3 rounded-md border border-border bg-background p-3">
                                <p className="font-medium">{context.question.prompt}</p>
                                {context.question.explanation ? (
                                  <p className="mt-2 text-muted-foreground">
                                    {context.question.explanation}
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
            {showChecks ? (
              <Button onClick={() => void start()}>{t('learningFeedback.start')}</Button>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default LearningFeedbackDialog;
