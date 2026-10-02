'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import type {
  LearningAnswer,
  LearningCheckPayloadV1,
  LearningQuestion,
  LearningQuestionGrade,
} from '@/lib/learning/contracts';
import { listLearningCheckAttempts, recordLearningCheckPhase } from '@/lib/learning/runtime';
import { getCurrentModelConfig, modelRequestHeaders } from '@/lib/utils/model-config';

export function gradeLearningSelection(
  question: LearningQuestion,
  answer: string[],
): LearningQuestionGrade {
  const expected = [...(question.correctAnswer ?? [])].sort();
  const actual = [...answer].sort();
  const correct =
    expected.length > 0 &&
    expected.length === actual.length &&
    expected.every((value, index) => value === actual[index]);
  return {
    status: 'graded',
    score: correct ? question.maxScore : 0,
    comment: question.explanation,
    basis: 'deterministic',
  };
}

function modelHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...modelRequestHeaders(getCurrentModelConfig()),
  };
}

async function gradeShortAnswer(
  question: LearningQuestion,
  answer: string,
  language: string,
  blankComment: string,
): Promise<LearningQuestionGrade> {
  if (!answer.trim()) {
    return {
      status: 'graded',
      score: 0,
      comment: blankComment,
      basis: 'deterministic',
    };
  }
  try {
    const response = await fetch('/api/quiz-grade', {
      method: 'POST',
      headers: modelHeaders(),
      body: JSON.stringify({
        question: question.prompt,
        userAnswer: answer,
        points: question.maxScore,
        commentPrompt: question.scoringGuide,
        language,
      }),
    });
    const data = (await response.json().catch(() => null)) as {
      score?: unknown;
      comment?: unknown;
    } | null;
    if (
      !response.ok ||
      typeof data?.score !== 'number' ||
      !Number.isInteger(data.score) ||
      data.score < 0 ||
      data.score > question.maxScore ||
      typeof data.comment !== 'string'
    ) {
      throw new Error('invalid grade');
    }
    return { status: 'graded', score: data.score, comment: data.comment, basis: 'model' };
  } catch {
    return { status: 'error', message: 'grading-unavailable' };
  }
}

export async function gradeSubmittedLearningCheck(input: {
  stageId: string;
  payload: LearningCheckPayloadV1;
  language: string;
  blankComment: string;
  persist?: typeof recordLearningCheckPhase;
  gradeShort?: typeof gradeShortAnswer;
  readLatest?: () => Promise<LearningCheckPayloadV1 | undefined>;
  now?: () => string;
}): Promise<LearningCheckPayloadV1> {
  if (input.payload.lifecycle.phase !== 'submitted') {
    throw new Error('Only a submitted learning check can be graded');
  }
  const gradeShort = input.gradeShort ?? gradeShortAnswer;
  const gradingEntries = await Promise.all(
    input.payload.questionSet.questions.map(async (question) => {
      const prior = input.payload.lifecycle.grading[question.id];
      if (prior?.status === 'graded') return [question.id, prior] as const;
      const answer = input.payload.lifecycle.answers[question.id];
      const grade =
        question.type === 'short_answer'
          ? await gradeShort(
              question,
              typeof answer === 'string' ? answer : '',
              input.language,
              input.blankComment,
            )
          : gradeLearningSelection(question, Array.isArray(answer) ? answer : []);
      return [question.id, grade] as const;
    }),
  );
  const grading = {
    ...input.payload.lifecycle.grading,
    ...Object.fromEntries(gradingEntries),
  };
  const fullyGraded = input.payload.questionSet.questions.every(
    (question) => grading[question.id]?.status === 'graded',
  );
  const next: LearningCheckPayloadV1 = {
    ...input.payload,
    lifecycle: fullyGraded
      ? {
          ...input.payload.lifecycle,
          phase: 'reviewed',
          grading,
          reviewedAt: (input.now ?? (() => new Date().toISOString()))(),
        }
      : {
          ...input.payload.lifecycle,
          phase: 'submitted',
          grading,
        },
  };
  const persist = input.persist ?? recordLearningCheckPhase;
  await persist(input.stageId, next);
  const readLatest =
    input.readLatest ??
    (input.persist
      ? undefined
      : async () =>
          (await listLearningCheckAttempts(input.stageId)).find(
            (attempt) => attempt.payload.identity.attemptId === input.payload.identity.attemptId,
          )?.payload);
  const durable = (await readLatest?.()) ?? next;
  if (
    durable.lifecycle.phase === 'submitted' &&
    durable.questionSet.questions.every(
      (question) => durable.lifecycle.grading[question.id]?.status === 'graded',
    )
  ) {
    const reviewed: LearningCheckPayloadV1 = {
      ...durable,
      lifecycle: {
        ...durable.lifecycle,
        phase: 'reviewed',
        reviewedAt: (input.now ?? (() => new Date().toISOString()))(),
      },
    };
    await persist(input.stageId, reviewed);
    return reviewed;
  }
  return durable;
}

export interface LearningCheckFormProps {
  stageId: string;
  payload: LearningCheckPayloadV1;
  onReviewed: (payload: LearningCheckPayloadV1) => void | Promise<void>;
  persist?: typeof recordLearningCheckPhase;
}

export function LearningCheckForm({
  stageId,
  payload,
  onReviewed,
  persist = recordLearningCheckPhase,
}: LearningCheckFormProps) {
  const { locale, t } = useI18n();
  const [currentPayload, setCurrentPayload] = useState(payload);
  const [answers, setAnswers] = useState<Record<string, LearningAnswer>>(payload.lifecycle.answers);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const answersLocked = currentPayload.lifecycle.phase !== 'draft';

  useEffect(() => {
    setCurrentPayload(payload);
    setAnswers(payload.lifecycle.answers);
  }, [payload]);

  const toggleChoice = (question: LearningQuestion, value: string) => {
    setAnswers((current) => {
      const selected = Array.isArray(current[question.id])
        ? (current[question.id] as string[])
        : [];
      if (question.type === 'single') return { ...current, [question.id]: [value] };
      return {
        ...current,
        [question.id]: selected.includes(value)
          ? selected.filter((candidate) => candidate !== value)
          : [...selected, value],
      };
    });
  };

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      let submitted = currentPayload;
      if (currentPayload.lifecycle.phase === 'draft') {
        submitted = {
          ...currentPayload,
          lifecycle: {
            ...currentPayload.lifecycle,
            phase: 'submitted',
            answers,
            grading: {},
            submittedAt: new Date().toISOString(),
          },
        };
        await persist(stageId, submitted);
      }
      const graded = await gradeSubmittedLearningCheck({
        stageId,
        payload: submitted,
        language: locale,
        blankComment: t('learningFeedback.blankAnswer'),
        persist,
      });
      setCurrentPayload(graded);
      if (graded.lifecycle.phase === 'reviewed') await onReviewed(graded);
      else setError(t('learningFeedback.gradingPending'));
    } catch {
      setError(t('learningFeedback.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {currentPayload.questionSet.questions.map((question, index) => (
        <fieldset key={question.id} className="space-y-3 rounded-xl border border-border p-4">
          <legend className="px-1 text-sm font-semibold">
            {index + 1}. {question.prompt}
          </legend>
          {question.type === 'short_answer' ? (
            <textarea
              value={typeof answers[question.id] === 'string' ? answers[question.id] : ''}
              maxLength={4_000}
              disabled={answersLocked}
              onChange={(event) =>
                setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
              }
              className="min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('learningFeedback.answerLabel')}
            />
          ) : (
            <div className="space-y-2">
              {question.options?.map((option) => {
                const selected = Array.isArray(answers[question.id])
                  ? (answers[question.id] as string[]).includes(option.value)
                  : false;
                return (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2"
                  >
                    <input
                      type={question.type === 'single' ? 'radio' : 'checkbox'}
                      name={question.id}
                      checked={selected}
                      disabled={answersLocked}
                      onChange={() => toggleChoice(question, option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
      ))}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting}>
        {submitting ? <Loader2 className="animate-spin" /> : null}
        {currentPayload.lifecycle.phase === 'submitted'
          ? t('learningFeedback.retryGrading')
          : t('learningFeedback.submit')}
      </Button>
    </form>
  );
}
