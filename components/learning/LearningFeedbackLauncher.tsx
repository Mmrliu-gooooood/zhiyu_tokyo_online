'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { ClipboardCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { RemediationContext } from '@/lib/learning/remediation';
import type { Scene, Stage } from '@/lib/types/stage';

const LearningFeedbackDialog = dynamic(
  () => import('./LearningFeedbackDialog').then((module) => module.LearningFeedbackDialog),
  { ssr: false },
);

export interface LearningFeedbackLauncherProps {
  stage: Stage;
  scenes: readonly Scene[];
  onReviewScene?: (sceneId: string) => Promise<unknown> | unknown;
  onDiscussQuestion?: (context: RemediationContext, prompt: string) => Promise<unknown> | unknown;
  onBeforeAnswer?: () => Promise<unknown> | unknown;
  showChecks?: boolean;
  showTeachBack?: boolean;
  onRestoreTeachBack?: (activity: import('@/lib/learning/teach-back/activity').TeachBackProjectedActivity) => void;
}

export function LearningFeedbackLauncher({
  stage,
  scenes,
  onReviewScene,
  onDiscussQuestion,
  onBeforeAnswer,
  showChecks = true,
  showTeachBack = false,
  onRestoreTeachBack,
}: LearningFeedbackLauncherProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="max-w-32 px-2"
        onClick={() => setOpen(true)}
        aria-label={t('learningFeedback.open')}
        title={t('learningFeedback.open')}
      >
        <ClipboardCheck />
        <span className="truncate max-[420px]:sr-only">{t('learningFeedback.shortTitle')}</span>
      </Button>
      {open ? (
        <LearningFeedbackDialog
          open={open}
          onOpenChange={setOpen}
          stage={stage}
          scenes={scenes}
          onReviewScene={onReviewScene}
          onDiscussQuestion={onDiscussQuestion}
          onBeforeAnswer={onBeforeAnswer}
          showChecks={showChecks}
          showTeachBack={showTeachBack}
          onRestoreTeachBack={onRestoreTeachBack}
        />
      ) : null}
    </>
  );
}
