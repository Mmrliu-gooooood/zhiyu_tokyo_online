'use client';

/**
 * The subject's explanations (learning plan B13), newest first. Opened with
 * `?item=` (from the wrong-answer book, the review list or an after-class
 * chat about a wrong question) it first shows that question with its help
 * steps, where a new explanation can be asked for.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { MathText } from '@/components/study/exams/exam-format';
import {
  FORMAT_ICONS,
  useExplanationStatusLabel,
} from '@/components/study/explanations/ExplainSection';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { RelativeTime } from '@/components/study/spaces/study-format';
import { WrongItemBody } from '@/components/study/wrongbook/WrongbookPage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { explanationApi, explanationHref } from '@/lib/study/explanations/client';
import type { ExplanationSummary } from '@/lib/study/explanations/contracts';
import { StudyApiError, fetchStudyCapabilities, studyApi } from '@/lib/study/spaces/client';
import { isWrongItemId } from '@/lib/study/wrongbook/contracts';
import { cn } from '@/lib/utils';

export function ExplanationsPage({ spaceId }: { spaceId: string }) {
  const { t } = useI18n();
  const statusLabel = useExplanationStatusLabel();
  const params = useSearchParams();
  const item = params.get('item');
  const itemId = isWrongItemId(item) ? item : null;
  const [state, setState] = useState<StudyLoadState>('loading');
  const [loadKey, setLoadKey] = useState(0);
  const [spaceName, setSpaceName] = useState('');
  const [flags, setFlags] = useState({ chatOn: false, practiceOn: false });
  const [list, setList] = useState<ExplanationSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      const capabilities = await fetchStudyCapabilities();
      if (!capabilities.explanations) throw new StudyApiError(404, 'STUDY_NOT_AVAILABLE', null);
      const space = await studyApi.getSpace(spaceId);
      const explanations = await explanationApi.list(spaceId);
      return { capabilities, space, explanations };
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') {
        setSpaceName(result.data.space.name);
        setList(result.data.explanations);
        setFlags({
          chatOn: result.data.capabilities.companionChat,
          practiceOn: result.data.capabilities.practice,
        });
      }
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, loadKey]);

  if (state !== 'ready') {
    return (
      <StudyShell>
        <StudyStatus
          state={state}
          onRetry={() => {
            setState('loading');
            setLoadKey((key) => key + 1);
          }}
        />
      </StudyShell>
    );
  }

  return (
    <StudyShell>
      <Link
        href={`/study/${encodeURIComponent(spaceId)}/wrongbook`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t('study.wrongbook.title')} · {spaceName}
      </Link>
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground md:text-3xl">
          {t('study.explain.pageTitle')}
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          {t('study.explain.pageSubtitle')}
        </p>
      </header>

      {itemId ? (
        <section
          className="mb-6 rounded-2xl border border-border bg-card"
          data-testid="explanations-item"
        >
          <h2 className="px-4 pt-3 text-xs font-medium text-muted-foreground">
            {t('study.explain.thisQuestion')}
          </h2>
          <WrongItemBody
            itemId={itemId}
            spaceId={spaceId}
            chatOn={flags.chatOn}
            practiceOn={flags.practiceOn}
            explainOn
          />
        </section>
      ) : null}

      <h2 className="mb-2 text-sm font-medium text-foreground">
        {t('study.explain.all', { count: list.length })}
      </h2>
      {list.length === 0 ? (
        <p
          className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground"
          data-testid="explanations-empty"
        >
          {t('study.explain.empty')}
        </p>
      ) : (
        <ul
          className="divide-y divide-border rounded-2xl border border-border"
          data-testid="explanations-list"
        >
          {list.map((entry) => {
            const Icon = FORMAT_ICONS[entry.format];
            return (
              <li key={entry.id}>
                <Link
                  href={explanationHref(spaceId, entry.id)}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-muted/40"
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">
                      {entry.title ?? t(`study.explain.format.${entry.format}`)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      <MathText text={entry.stem} />
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs">
                    <span
                      className={cn(
                        entry.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {statusLabel(entry)}
                    </span>
                    <RelativeTime iso={entry.createdAt} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </StudyShell>
  );
}
