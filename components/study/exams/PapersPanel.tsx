'use client';

/**
 * A subject's papers and their attempts (learning plan B07): continue an
 * open attempt (also from another device), read a submitted report, take a
 * paper again (a new, independent attempt) or delete it. Papers are frozen,
 * so their questions never change with the bank.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, LoaderCircle, Play, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { RelativeTime } from '@/components/study/spaces/study-format';
import { useI18n } from '@/lib/hooks/use-i18n';
import { examsApi } from '@/lib/study/assessments/client';
import type { PaperSummary } from '@/lib/study/assessments/contracts';

export function PapersPanel({ spaceId, archived }: { spaceId: string; archived: boolean }) {
  const { t } = useI18n();
  const router = useRouter();
  const [papers, setPapers] = useState<PaperSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PaperSummary | null>(null);

  const load = useCallback(
    () =>
      examsApi.papers(spaceId).then(
        (list) => {
          setPapers(list);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [spaceId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const attemptHref = (attemptId: string) =>
    `/study/${encodeURIComponent(spaceId)}/attempts/${encodeURIComponent(attemptId)}`;

  async function take(paper: PaperSummary) {
    setBusy(paper.id);
    try {
      const attempt = await examsApi.start(paper.id);
      router.push(attemptHref(attempt.id));
    } catch {
      toast.error(t('study.errors.generic'));
      setBusy(null);
    }
  }

  if (failed) {
    return (
      <div className="rounded-2xl border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
        {t('study.state.error')}
        <Button variant="link" onClick={() => void load()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (!papers) {
    return (
      <div className="flex justify-center py-10">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (papers.length === 0) {
    return (
      <div
        className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-sm leading-6 text-muted-foreground"
        data-testid="papers-empty"
      >
        {t('study.practice.papers.empty')}
      </div>
    );
  }

  return (
    <section>
      <ul className="space-y-2" data-testid="paper-list">
        {papers.map((paper) => {
          const open = paper.attempts.find((attempt) => attempt.status === 'in_progress');
          const submitted = paper.attempts.filter((attempt) => attempt.status === 'submitted');
          return (
            <li
              key={paper.id}
              data-testid="paper-row"
              className="rounded-2xl border border-border bg-card p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{paper.title}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('study.practice.papers.meta', {
                      count: paper.itemCount,
                      points: paper.totalPoints,
                    })}
                    {' · '}
                    <RelativeTime iso={paper.createdAt} />
                  </p>
                  {submitted.length ? (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {submitted.map((attempt) => (
                        <li key={attempt.id}>
                          <Link
                            href={attemptHref(attempt.id)}
                            className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs text-primary hover:bg-primary/15"
                          >
                            <FileText className="size-3" />
                            {t('study.practice.papers.score', {
                              earned: attempt.earned ?? 0,
                              total: attempt.totalPoints ?? 0,
                            })}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {open ? (
                    <Button size="sm" asChild data-testid="paper-continue">
                      <Link href={attemptHref(open.id)}>
                        <Play className="mr-1 size-4" />
                        {t('study.practice.papers.continue')}
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={submitted.length ? 'outline' : 'default'}
                      disabled={busy === paper.id}
                      onClick={() => void take(paper)}
                    >
                      {submitted.length ? (
                        <RotateCcw className="mr-1 size-4" />
                      ) : (
                        <Play className="mr-1 size-4" />
                      )}
                      {submitted.length
                        ? t('study.practice.papers.again')
                        : t('study.practice.papers.start')}
                    </Button>
                  )}
                  {!archived ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 text-muted-foreground"
                      aria-label={t('study.delete')}
                      onClick={() => setRemoving(paper)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <AlertDialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.practice.papers.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('study.practice.papers.deleteText', { title: removing?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = removing;
                setRemoving(null);
                if (!target) return;
                void examsApi
                  .removePaper(target.id)
                  .then(load)
                  .catch(() => toast.error(t('study.errors.generic')));
              }}
            >
              {t('study.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
