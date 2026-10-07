'use client';

/**
 * "继续问这个学伴" under a classmate's classroom reply (learning plan B05).
 * Opens the after-class chat in a new tab (the classroom keeps playing) with
 * the course, the current page, the classmate's classroom agent id and the
 * question being discussed — only references and a short excerpt, never the
 * course itself.
 */
import { useEffect, useState } from 'react';
import { MessageCircleMore } from 'lucide-react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import { parseClassmateStageAgentId } from '@/lib/study/classmates/contracts';
import { COMPANION_LIMITS } from '@/lib/study/companion/contracts';
import { fetchStudyCapabilities } from '@/lib/study/spaces/client';

let enabledPromise: Promise<boolean> | undefined;

function useCompanionChatEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    enabledPromise ??= fetchStudyCapabilities()
      .then((capabilities) => capabilities.companionChat)
      .catch(() => false);
    void enabledPromise.then((value) => active && setEnabled(value));
    return () => {
      active = false;
    };
  }, []);
  return enabled;
}

/** The chat URL for one classmate reply; null for any other agent. */
export function continueWithClassmateHref(input: {
  agentId: string | undefined;
  stageId: string | undefined;
  sceneId: string | null | undefined;
  question: string;
}): string | null {
  const ref = parseClassmateStageAgentId(input.agentId);
  if (!ref || !input.stageId) return null;
  const params = new URLSearchParams({ stage: input.stageId, agent: input.agentId! });
  if (input.sceneId) params.set('scene', input.sceneId);
  const question = Array.from(input.question.trim())
    .slice(0, COMPANION_LIMITS.originExcerpt)
    .join('');
  if (question) params.set('q', question);
  return `/study/classmates/${encodeURIComponent(ref.classmateId)}/chat?${params.toString()}`;
}

export function ContinueWithClassmate({
  agentId,
  name,
  question,
}: {
  agentId: string | undefined;
  name: string;
  question: string;
}) {
  const { t } = useI18n();
  const enabled = useCompanionChatEnabled();
  const stageId = useStageStore((state) => state.stage?.id);
  const sceneId = useStageStore((state) => state.currentSceneId);
  if (!enabled) return null;
  const href = continueWithClassmateHref({ agentId, stageId, sceneId, question });
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      data-testid="continue-with-classmate"
      className="mt-1 inline-flex items-center gap-1 text-[10px] text-[#5277B6] hover:underline dark:text-[#9BB4DE]"
    >
      <MessageCircleMore className="size-3" />
      {t('study.companion.continueWith', { name })}
    </a>
  );
}
