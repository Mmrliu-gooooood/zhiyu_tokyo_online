'use client';

/**
 * Home affordances for study spaces (learning plan B01): the "this course will
 * join <space>" banner when Home was opened from a space's "generate a course"
 * action (`/?studySpace=<id>`). Opened from a course explanation of a wrong
 * question (B13, `&studyExplanation=<id>`), the
 * banner says so, the requirement is filled in, and only the media the student
 * ticked there are generated.
 */
import { useEffect, useState } from 'react';
import { BookOpenCheck, X } from 'lucide-react';

import { peekAccountUserId } from '@/lib/auth/account-environment';
import { useI18n } from '@/lib/hooks/use-i18n';
import { explanationApi } from '@/lib/study/explanations/client';
import { isExplanationId, type CourseMedia } from '@/lib/study/explanations/contracts';
import { fetchStudyCapabilities, fetchStudyCapability, studyApi } from '@/lib/study/spaces/client';
import { isStudyId } from '@/lib/study/spaces/contracts';

export interface StudyGenerationTarget {
  id: string;
  name: string;
  /** B13: a course explanation waiting for its course (no course or job yet). */
  explanation?: { id: string; requirement: string; media: CourseMedia };
}

/**
 * The space named by `?studySpace=` on Home, once it is confirmed to be the
 * signed-in learner's active space. Cleared by the banner's close button.
 */
export function useStudyGenerationTarget(): {
  target: StudyGenerationTarget | null;
  clear: () => void;
} {
  const [target, setTarget] = useState<StudyGenerationTarget | null>(null);
  useEffect(() => {
    const spaceId = new URLSearchParams(window.location.search).get('studySpace');
    if (!isStudyId(spaceId)) return;
    let cancelled = false;
    void (async () => {
      if (!(await fetchStudyCapability()) || !peekAccountUserId()) return;
      try {
        const space = await studyApi.getSpace(spaceId);
        if (space.status !== 'active') return;
        const explanationId = new URLSearchParams(window.location.search).get('studyExplanation');
        let explanation: StudyGenerationTarget['explanation'];
        if (isExplanationId(explanationId) && (await fetchStudyCapabilities()).explanations) {
          const found = await explanationApi.get(explanationId).catch(() => null);
          if (
            found &&
            found.format === 'course' &&
            found.spaceId === space.id &&
            !found.stageId &&
            found.status !== 'ready'
          ) {
            explanation = {
              id: found.id,
              requirement: found.requirement ?? '',
              media: found.media ?? { image: false, tts: false, video: false },
            };
          }
        }
        if (!cancelled) {
          setTarget({ id: space.id, name: space.name, ...(explanation ? { explanation } : {}) });
        }
      } catch {
        // Not the learner's space (or not reachable): generate without a link.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const clear = () => {
    setTarget(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('studySpace');
    url.searchParams.delete('studyExplanation');
    window.history.replaceState(window.history.state, '', url.toString());
  };
  return { target, clear };
}

export function StudyGenerationTargetBanner({
  target,
  onClear,
}: {
  target: StudyGenerationTarget;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      data-testid="study-generation-target"
      className="mx-5 mt-3 flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 text-xs text-foreground"
    >
      <BookOpenCheck className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        {target.explanation
          ? t('study.explain.course.banner', {
              name: target.name,
              media:
                (['image', 'tts', 'video'] as const)
                  .filter((kind) => target.explanation!.media[kind])
                  .map((kind) => t(`study.explain.media.${kind}`))
                  .join('、') || t('study.explain.media.none'),
            })
          : t('study.generateInto', { name: target.name })}
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label={t('study.generateIntoCancel')}
        className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
