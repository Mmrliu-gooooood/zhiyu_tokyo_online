'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getDocumentStore } from '@/lib/document-store';
import { useStageStore } from '@/lib/store/stage';
import { isStageDeleted } from '@/lib/utils/deleted-stages';
import { migrateScene } from '@/lib/edit/slide-schema';
import type { AppDocument, AppDocumentOutline } from '@/lib/document-store';
import {
  diffStageManifest,
  fetchScenesByIds,
  fetchStageManifest,
  mergeFetchedScenes,
  sameIds,
  type StageManifest,
} from '@/lib/workbench/stage-freshness';
import {
  retryGenerationJob,
  cancelGenerationJob,
  observeGenerationJob,
  type GenerationJobSnapshot,
} from '@/lib/generation/job-client';

/** Read projection only: preserves playback, chat and edit state, never schedules a save. */
export function hydrateGenerationDocument(stageId: string, document: AppDocument): boolean {
  const state = useStageStore.getState();
  if (state.stage?.id !== stageId || document.stage.id !== stageId || isStageDeleted(stageId))
    return false;
  const outline = document.outline as AppDocumentOutline | undefined;
  if (outline?.producer !== 'server-job') return false;
  const oldScenes = new Map(state.scenes.map((scene) => [scene.id, scene]));
  const scenes = document.scenes
    .map((raw) => {
      const previous = oldScenes.get(raw.id);
      return previous && JSON.stringify(previous) === JSON.stringify(raw)
        ? previous
        : migrateScene(raw);
    })
    .sort((a, b) => a.order - b.order);
  const outlines =
    JSON.stringify(state.outlines) === JSON.stringify(outline.outlines)
      ? state.outlines
      : (outline.outlines ?? []);
  useStageStore.setState({
    stage: document.stage,
    scenes:
      scenes.length === state.scenes.length &&
      scenes.every((scene, index) => scene === state.scenes[index])
        ? state.scenes
        : scenes,
    outlines,
    outlineProducer: 'server-job',
    outlineProducerRef: outline.producerRef ?? null,
    outlineProducerKind: outline.producerKind ?? null,
    generationComplete: outline.generationComplete === true,
    generatingOutlines: outline.generationComplete
      ? []
      : outlines.filter((o) => !scenes.some((s) => s.order === o.order)),
    currentSceneId:
      state.currentSceneId === '__pending__' || scenes.some((s) => s.id === state.currentSceneId)
        ? state.currentSceneId
        : (scenes[0]?.id ?? null),
  });
  return true;
}

export function useGenerationJob(
  jobId: string | null,
  onSnapshot?: (job: GenerationJobSnapshot) => void,
) {
  const [observation, setObservation] = useState<{
    jobId: string;
    job: GenerationJobSnapshot | null;
    error: Error | null;
  } | null>(null);
  const callback = useRef(onSnapshot);
  useEffect(() => {
    callback.current = onSnapshot;
  }, [onSnapshot]);
  useEffect(() => {
    if (!jobId) return;
    return observeGenerationJob(
      jobId,
      (snapshot) => {
        setObservation({ jobId, job: snapshot, error: null });
        callback.current?.(snapshot);
      },
      (error) =>
        setObservation((previous) => ({
          jobId,
          job: previous?.jobId === jobId ? previous.job : null,
          error,
        })),
    );
  }, [jobId]);
  const cancel = useCallback(async () => {
    if (!jobId) return;
    const cancelled = await cancelGenerationJob(jobId);
    setObservation({ jobId, job: cancelled, error: null });
  }, [jobId]);
  return { ...(observation?.jobId === jobId ? observation : { job: null, error: null }), cancel };
}

/** Agent runtime server jobs have their own observer; only generation refs enter this hook. */
export function useClassroomGenerationJob(stageId: string, enabled: boolean) {
  const router = useRouter();
  const jobRef = useRef<GenerationJobSnapshot | null>(null);
  const retryInFlightRef = useRef<Promise<void> | null>(null);
  const producerRef = useStageStore((state) =>
    state.stage?.id === stageId ? state.outlineProducerRef : null,
  );
  const producerKind = useStageStore((state) =>
    state.stage?.id === stageId ? state.outlineProducerKind : null,
  );
  useEffect(() => {
    if (!enabled || !producerRef || producerKind !== 'course-worker') return;
    let active = true;
    let baseline: StageManifest | null = null;
    let hasPublishedBaseline = false;
    const stop = observeGenerationJob(
      producerRef,
      async (job) => {
        if (!active) return;
        jobRef.current = job;
        if (
          ['awaiting_confirmation', 'failed', 'needs_attention'].includes(job.status) &&
          job.readyScenes === 0
        ) {
          router.replace(`/generation-preview?jobId=${encodeURIComponent(job.jobId)}`);
          return;
        }
        // Capture the manifest before content so the baseline never claims a newer read.
        const manifest = await fetchStageManifest(stageId);
        if (!active) return;
        if (manifest.status !== 'ok') throw new Error('GENERATION_DOCUMENT_UNAVAILABLE');
        let document: AppDocument | null;
        if (!baseline || !hasPublishedBaseline) {
          document = await getDocumentStore().loadDocument(stageId);
        } else {
          const diff = diffStageManifest(baseline, manifest.manifest);
          const ids = [...diff.added, ...diff.changed];
          const fetched = await fetchScenesByIds(stageId, ids);
          if (!active) return;
          if (
            !sameIds(
              ids,
              fetched.map((scene) => scene.id),
            )
          )
            throw new Error('GENERATION_SCENES_UNAVAILABLE');
          const state = useStageStore.getState();
          if (state.stage?.id !== stageId) return;
          const merged = mergeFetchedScenes({
            current: state.scenes,
            fetched,
            removedIds: diff.removed,
          });
          document = {
            stage: state.stage,
            scenes: [...merged.scenes],
            outline: {
              outlines: job.outlines ?? state.outlines,
              producer: 'server-job',
              producerKind: 'course-worker',
              producerRef,
              generationComplete: job.status === 'succeeded',
              createdAt: state.stage.createdAt,
              updatedAt: state.stage.updatedAt,
            },
          };
        }
        if (active && document && hydrateGenerationDocument(stageId, document)) {
          baseline = manifest.manifest;
          hasPublishedBaseline = job.readyScenes > 0;
          const state = useStageStore.getState();
          const failedIds = new Set(
            job.scenes
              ?.filter((scene) => ['failed', 'needs_attention'].includes(scene.status))
              .map((scene) => scene.outlineId),
          );
          useStageStore.setState({
            generationStatus:
              job.status === 'succeeded'
                ? 'completed'
                : ['failed', 'needs_attention'].includes(job.status)
                  ? 'error'
                  : ['awaiting_confirmation', 'cancelled'].includes(job.status)
                    ? 'paused'
                    : 'generating',
            failedOutlines: state.outlines.filter((outline) => failedIds.has(outline.id)),
          });
        }
      },
      () => {
        /* Retain the last valid document while polling retries. */
      },
    );
    return () => {
      active = false;
      stop();
    };
  }, [stageId, enabled, producerRef, producerKind, router]);
  const retry = useCallback(async (): Promise<void> => {
    if (retryInFlightRef.current) return retryInFlightRef.current;
    const job = jobRef.current;
    if (!job || job.stageId !== stageId) return;
    const pending = retryGenerationJob(job)
      .then((updated) => {
        if (updated && jobRef.current?.jobId === updated.jobId) jobRef.current = updated;
      })
      .finally(() => {
        retryInFlightRef.current = null;
      });
    retryInFlightRef.current = pending;
    return pending;
  }, [stageId]);
  return producerKind === 'course-worker' ? retry : null;
}
