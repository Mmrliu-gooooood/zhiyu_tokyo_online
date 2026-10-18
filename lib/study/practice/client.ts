'use client';

/**
 * Browser client for AI practice (learning plan B11): the preview with a
 * generation plan, jobs (create, run step by step with the user's model,
 * continue, cancel, publish) and hints/solutions in practice attempts.
 * Errors surface as StudyApiError with the server's fixed code.
 */
import { studyRequest } from '@/lib/study/spaces/client';
import { getCurrentModelConfig, modelRequestHeaders } from '@/lib/utils/model-config';
import type { BlueprintRequest } from '@/lib/study/assessments/client';
import type { AttemptView, PaperSummary } from '@/lib/study/assessments/contracts';
import type { ExamBlueprint, PaperPreview } from '@/lib/study/questions/blueprint';

import type { GenerationPlan, PracticeJobView, PracticeMode } from './contracts';

const enc = encodeURIComponent;

function modelSelection(): { headers: Record<string, string>; thinking: unknown } {
  try {
    const config = getCurrentModelConfig();
    return { headers: modelRequestHeaders(config), thinking: config.thinkingConfig };
  } catch {
    return { headers: {}, thinking: undefined };
  }
}

export type PracticePreview = PaperPreview & { generation: GenerationPlan };

export const practiceApi = {
  preview: (blueprint: BlueprintRequest, mode: PracticeMode) =>
    studyRequest<{ preview: PracticePreview }>('/api/study/exams/preview', {
      method: 'POST',
      json: { blueprint, mode },
    }).then((body) => body.preview),
  createPaperJob: (input: {
    blueprint: ExamBlueprint;
    mode: PracticeMode;
    materialVersionIds: string[] | null;
    idempotencyKey: string;
  }) =>
    studyRequest<{ job: PracticeJobView }>('/api/study/practice/jobs', {
      method: 'POST',
      json: { kind: 'paper', consent: true, ...input },
    }).then((body) => body.job),
  createVariantJob: (wrongItemId: string, count: number, idempotencyKey: string) =>
    studyRequest<{ job: PracticeJobView }>('/api/study/practice/jobs', {
      method: 'POST',
      json: { kind: 'variant', consent: true, wrongItemId, count, idempotencyKey },
    }).then((body) => body.job),
  job: (jobId: string) =>
    studyRequest<{ job: PracticeJobView }>(`/api/study/practice/jobs/${enc(jobId)}`).then(
      (body) => body.job,
    ),
  /** Run the next step (one batch) with the user's selected model. */
  run: (jobId: string, signal?: AbortSignal) => {
    const { headers, thinking } = modelSelection();
    return studyRequest<{ job: PracticeJobView; ran: boolean }>(
      `/api/study/practice/jobs/${enc(jobId)}/run`,
      {
        method: 'POST',
        headers,
        json: thinking ? { thinkingConfig: thinking } : {},
        signal,
      },
    );
  },
  cancel: (jobId: string) =>
    studyRequest<{ job: PracticeJobView }>(`/api/study/practice/jobs/${enc(jobId)}/cancel`, {
      method: 'POST',
    }).then((body) => body.job),
  continue: (jobId: string) =>
    studyRequest<{ job: PracticeJobView }>(`/api/study/practice/jobs/${enc(jobId)}/continue`, {
      method: 'POST',
    }).then((body) => body.job),
  publish: (
    jobId: string,
    input: { title?: string; idempotencyKey: string; acceptShort: boolean },
  ) =>
    studyRequest<{ paper: PaperSummary }>(`/api/study/practice/jobs/${enc(jobId)}/paper`, {
      method: 'POST',
      json: input,
    }).then((body) => body.paper),
  assist: (attemptId: string, position: number, level: 'hint' | 'solution') =>
    studyRequest<{ attempt: AttemptView }>(`/api/study/attempts/${enc(attemptId)}/assist`, {
      method: 'POST',
      json: { position, level },
    }).then((body) => body.attempt),
};

/**
 * Run a job until it is no longer pending (one request per step). Stops on
 * abort; a step held by another request is waited for with a short pause.
 */
export async function runPracticeJob(
  job: PracticeJobView,
  onUpdate: (job: PracticeJobView) => void,
  signal: AbortSignal,
): Promise<PracticeJobView> {
  let current = job;
  while (current.status === 'pending' && !signal.aborted) {
    const result = await practiceApi.run(current.id, signal);
    current = result.job;
    onUpdate(current);
    if (!result.ran && current.status === 'pending') {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  return current;
}
