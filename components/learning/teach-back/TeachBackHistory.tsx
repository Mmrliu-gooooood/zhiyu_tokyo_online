'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { listTeachBackActivities } from '@/lib/learning/teach-back/runtime';
import type { TeachBackProjectedActivity } from '@/lib/learning/teach-back/activity';

export function TeachBackHistory({
  stageId,
  enabled,
  onRestore,
}: {
  stageId: string;
  enabled: boolean;
  onRestore?: (activity: TeachBackProjectedActivity) => void;
}) {
  const { t } = useI18n();
  const [activities, setActivities] = useState<TeachBackProjectedActivity[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setActivities([]);
      return;
    }
    let cancelled = false;
    void listTeachBackActivities(stageId)
      .then((items) => {
        if (!cancelled) setActivities([...items].reverse());
      })
      .catch(() => {
        if (!cancelled) setActivities([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, stageId]);

  if (!enabled) return null;

  return (
    <section data-testid="teach-back-history" className="space-y-3">
      <h3 className="text-sm font-semibold">{t('learningFeedback.teachBack.title')}</h3>
      {activities.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('learningFeedback.teachBack.empty')}</p>
      ) : (
        activities.map((activity) => {
          const open = openId === activity.activityId;
          return (
            <article key={activity.activityId} className="rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-semibold">{activity.topic ?? t('chat.teachBack.label')}</h4>
                <span className="text-xs text-muted-foreground">
                  {t(`learningFeedback.teachBack.phase.${activity.logicalPhase}`)}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {activity.source?.title} · {t('chat.teachBack.waiting', { n: activity.explanations.length, max: 3 })}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={() => setOpenId(open ? null : activity.activityId)}>
                  {open ? t('learningFeedback.teachBack.hide') : t('learningFeedback.teachBack.expand')}
                </Button>
                {onRestore && activity.logicalPhase !== 'finished' ? (
                  <Button type="button" size="sm" onClick={() => onRestore(activity)}>
                    {t('chat.teachBack.restore')}
                  </Button>
                ) : null}
              </div>
              {open ? (
                <div className="mt-3 space-y-2 text-sm">
                  {activity.explanations.map((explanation) => (
                    <p key={explanation.turnId}>
                      {t('chat.teachBack.yourExplanation')} {explanation.turnIndex}: {explanation.text}
                    </p>
                  ))}
                  {activity.summary?.criteria.map((item) => (
                    <p key={item.criterionId}>
                      {t(`chat.teachBack.status.${item.status}`)}: {item.reason}
                    </p>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })
      )}
    </section>
  );
}
