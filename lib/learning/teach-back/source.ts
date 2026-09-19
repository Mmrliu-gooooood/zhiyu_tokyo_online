import { createLearningContentSnapshot } from '@/lib/learning/content-snapshot';
import { LEARNING_SNAPSHOT_ALGORITHM_VERSION } from '@/lib/learning/contracts';
import { loadQuizAttemptState } from '@/lib/quiz/runtime';
import type { Scene } from '@/lib/types/stage';
import {
  readableSourceLength,
  TEACH_BACK_LIMITS,
  type TeachBackErrorCode,
  type TeachBackPeer,
  type TeachBackSource,
} from './contracts';

export function selectTeachBackPeers(
  agents: readonly {
    id: string;
    name: string;
    role: string;
    persona?: string;
    avatar?: string;
    color?: string;
  }[],
): TeachBackPeer[] {
  return agents
    .filter((agent) => agent.role !== 'teacher')
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      persona: agent.persona ?? '',
      avatar: agent.avatar ?? '',
      color: agent.color ?? '',
    }));
}

export async function isUnsubmittedQuizScene(scene: Scene): Promise<boolean | 'unknown'> {
  if (scene.type !== 'quiz') return false;
  try {
    const { state } = await Promise.race([
      loadQuizAttemptState({ stageId: scene.stageId, sceneId: scene.id }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('quiz-state-timeout')), 1500);
      }),
    ]);
    return state?.phase !== 'reviewed';
  } catch {
    return 'unknown';
  }
}

export async function buildTeachBackSource(input: {
  stageId: string;
  courseTitle: string;
  scene: Scene;
}): Promise<{ ok: true; source: TeachBackSource } | { ok: false; code: TeachBackErrorCode }> {
  const quizState = await isUnsubmittedQuizScene(input.scene);
  if (quizState === true || quizState === 'unknown') {
    return { ok: false, code: quizState === true ? 'quiz_in_progress' : 'quiz_in_progress' };
  }

  const snapshot = await createLearningContentSnapshot({
    courseTitle: input.courseTitle,
    scenes: [input.scene],
  });
  const fragments = snapshot.fragments
    .filter((fragment) => fragment.sourceRef.sceneId === input.scene.id)
    .map((fragment) => ({
      id: fragment.id,
      digest: fragment.digest,
      text: fragment.text.slice(0, TEACH_BACK_LIMITS.fragmentCharacters),
    }))
    .filter((fragment) => readableSourceLength(fragment.text) >= TEACH_BACK_LIMITS.minSourceCharacters);

  if (fragments.length === 0) {
    return { ok: false, code: 'insufficient_source' };
  }

  return {
    ok: true,
    source: {
      stageId: input.stageId,
      sceneId: input.scene.id,
      sceneType: input.scene.type,
      title: input.scene.title,
      courseTitle: input.courseTitle,
      snapshotAlgorithmVersion: snapshot.snapshotAlgorithmVersion || LEARNING_SNAPSHOT_ALGORITHM_VERSION,
      sourceRevision: snapshot.contentRevision,
      fragments,
      coverageLimited:
        snapshot.coverage.limitedSceneIds.includes(input.scene.id) ||
        snapshot.coverage.notes.length > 0,
    },
  };
}
