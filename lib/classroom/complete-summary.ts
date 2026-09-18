import type { QuizAttemptState } from '@/lib/quiz/runtime';
import type { Scene, SceneType } from '@/lib/types/stage';

export interface CompleteSummary {
  countsByType: Partial<Record<SceneType, number>>;
  quiz: { correct: number; total: number; pct: number } | null;
  quizStatus: { pending: number; unavailable: number; legacyAttempts: number };
}

export interface ResolvedCompleteSummary {
  scenes: Scene[];
  summary: CompleteSummary;
}

export function pendingCompleteSummary(scenes: Scene[]): CompleteSummary {
  return {
    countsByType: scenes.reduce<CompleteSummary['countsByType']>((counts, scene) => {
      counts[scene.type] = (counts[scene.type] ?? 0) + 1;
      return counts;
    }, {}),
    quiz: null,
    quizStatus: { pending: 0, unavailable: 0, legacyAttempts: 0 },
  };
}

/** Never render a completed summary produced for a different scenes snapshot. */
export function completeSummaryForScenes(
  scenes: Scene[],
  resolved: ResolvedCompleteSummary,
): CompleteSummary {
  return resolved.scenes === scenes ? resolved.summary : pendingCompleteSummary(scenes);
}

export type QuizAttemptReader = (sceneId: string) => Promise<QuizAttemptState | undefined>;

type QuizAttemptLoader = (input: {
  stageId: string;
  sceneId: string;
}) => Promise<{ state?: QuizAttemptState }>;

/** Skip malformed legacy scenes before opening their RuntimeStore partition. */
export async function readSceneQuizAttempt(
  scene: { id: string; stageId?: string } | undefined,
  load: QuizAttemptLoader,
): Promise<QuizAttemptState | undefined> {
  if (!scene?.stageId) return undefined;
  const { state } = await load({ stageId: scene.stageId, sceneId: scene.id });
  return state;
}

export async function summarizeScenes(
  scenes: Scene[],
  readAttempt: QuizAttemptReader,
): Promise<CompleteSummary> {
  const countsByType: Partial<Record<SceneType, number>> = {};
  for (const scene of scenes) {
    countsByType[scene.type] = (countsByType[scene.type] ?? 0) + 1;
  }

  let correct = 0;
  let total = 0;
  let pending = 0;
  let unavailable = 0;
  let legacyAttempts = 0;
  for (const scene of scenes) {
    if (scene.type !== 'quiz') continue;
    let attempt: Awaited<ReturnType<QuizAttemptReader>>;
    try {
      attempt = await readAttempt(scene.id);
    } catch {
      continue;
    }
    if (!attempt || attempt.phase === 'draft') continue;
    if (attempt.payloadVersion !== 2 || !attempt.questionSnapshot || !attempt.grading) {
      legacyAttempts += 1;
      continue;
    }
    for (const question of attempt.questionSnapshot) {
      const grading = attempt.grading[question.id];
      if (grading?.status === 'pending') {
        pending += 1;
        continue;
      }
      if (grading?.status === 'unavailable') {
        unavailable += 1;
        continue;
      }
      if (
        grading?.status !== 'graded' ||
        (question.type !== 'single' && question.type !== 'multiple') ||
        (grading.result.correct !== true && grading.result.correct !== false)
      ) {
        continue;
      }
      total += 1;
      if (grading.result.correct) correct += 1;
    }
  }

  const quiz = total > 0 ? { correct, total, pct: Math.round((correct / total) * 100) } : null;

  return {
    countsByType,
    quiz,
    quizStatus: { pending, unavailable, legacyAttempts },
  };
}
