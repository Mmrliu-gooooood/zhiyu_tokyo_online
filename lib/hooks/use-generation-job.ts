'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { nanoid } from 'nanoid';
import { getDocumentStore } from '@/lib/document-store';
import { useStageStore } from '@/lib/store/stage';
import { isStageDeleted } from '@/lib/utils/deleted-stages';
import { migrateScene } from '@/lib/edit/slide-schema';
import type { AppDocument, AppDocumentOutline } from '@/lib/document-store';
import type { SceneOutline } from '@/lib/types/generation';
import {
  projectGenerationJobDisplay,
  type GenerationJobDisplayProjection,
} from '@/lib/generation/job-display';
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

export function projectClassroomGenerationSnapshot(
  job: Pick<GenerationJobSnapshot, 'status' | 'retryAt' | 'displayProgress' | 'scenes'>,
  outlines: SceneOutline[],
): {
  display: GenerationJobDisplayProjection;
  generationStatus: 'generating' | 'paused' | 'completed' | 'error';
  failedOutlines: SceneOutline[];
} {
  const display = projectGenerationJobDisplay(job);
  const affected = new Set(display.affectedOutlineIds);
  return {
    display,
    generationStatus:
      job.status === 'succeeded'
        ? 'completed'
        : display.stopped
          ? 'error'
          : ['awaiting_confirmation', 'retry_wait', 'cancelled'].includes(job.status)
            ? 'paused'
            : 'generating',
    failedOutlines: display.stopped ? outlines.filter((outline) => affected.has(outline.id)) : [],
  };
}

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
  const activeJobIdRef = useRef(jobId);
  useEffect(() => {
    activeJobIdRef.current = jobId;
  }, [jobId]);
  const [observation, setObservation] = useState<{
    jobId: string;
    job: GenerationJobSnapshot | null;
    error: Error | null;
  } | null>(null);
  const [cancellation, setCancellation] = useState<{
    jobId: string;
    cancelling: boolean;
    error: Error | null;
  } | null>(null);
  const cancelCommandRef = useRef<{ jobId: string; key: string } | null>(null);
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
      () =>
        setObservation((previous) =>
          previous?.jobId === jobId ? { ...previous, error: null } : previous,
        ),
    );
  }, [jobId]);
  const cancel = useCallback(async (): Promise<GenerationJobSnapshot | undefined> => {
    if (!jobId) return;
    const requestedJobId = jobId;
    const command =
      cancelCommandRef.current?.jobId === requestedJobId
        ? cancelCommandRef.current
        : { jobId: requestedJobId, key: nanoid() };
    cancelCommandRef.current = command;
    setCancellation({ jobId: requestedJobId, cancelling: true, error: null });
    try {
      const cancelled = await cancelGenerationJob(requestedJobId, command.key);
      if (activeJobIdRef.current !== requestedJobId || cancelled.jobId !== requestedJobId)
        return undefined;
      cancelCommandRef.current = null;
      setObservation({ jobId: requestedJobId, job: cancelled, error: null });
      setCancellation({ jobId: requestedJobId, cancelling: false, error: null });
      return cancelled;
    } catch (failure) {
      const cancelError =
        failure instanceof Error ? failure : new Error('GENERATION_CANCELLATION_FAILED');
      if (activeJobIdRef.current === requestedJobId) {
        setCancellation({ jobId: requestedJobId, cancelling: false, error: cancelError });
      }
      throw cancelError;
    }
  }, [jobId]);
  return {
    ...(observation?.jobId === jobId ? observation : { job: null, error: null }),
    cancelling: cancellation?.jobId === jobId ? cancellation.cancelling : false,
    cancelError: cancellation?.jobId === jobId ? cancellation.error : null,
    cancel,
  };
}

/** Agent runtime server jobs have their own observer; only generation refs enter this hook. */
export function useClassroomGenerationJob(stageId: string, enabled: boolean) {
  const router = useRouter();
  const jobRef = useRef<GenerationJobSnapshot | null>(null);
  const retryInFlightRef = useRef<Promise<void> | null>(null);
  const [displayObservation, setDisplayObservation] = useState<{
    jobId: string;
    display: GenerationJobDisplayProjection;
  } | null>(null);
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
        const initialProjection = projectClassroomGenerationSnapshot(
          job,
          job.outlines ?? useStageStore.getState().outlines,
        );
        setDisplayObservation({ jobId: job.jobId, display: initialProjection.display });
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
          const projection = projectClassroomGenerationSnapshot(job, state.outlines);
          setDisplayObservation({ jobId: job.jobId, display: projection.display });
          useStageStore.setState({
            generationStatus: projection.generationStatus,
            failedOutlines: projection.failedOutlines,
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
  return producerKind === 'course-worker'
    ? {
        retry,
        display: displayObservation?.jobId === producerRef ? displayObservation.display : null,
      }
    : null;
}
