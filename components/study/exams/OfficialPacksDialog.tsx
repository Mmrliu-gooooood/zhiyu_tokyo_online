'use client';

/**
 * Browse the official question packs (learning plan B07): read-only, each
 * with its version, attribution and licence. Copying questions puts private,
 * editable copies into this subject's bank; the pack never changes. A pack
 * can also be used directly when building a paper.
 */
import { useEffect, useState } from 'react';
import { Copy, LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { QuizMathText } from '@/components/quiz/QuizMathText';
import { TypeChip } from '@/components/study/exams/exam-format';
import { useI18n } from '@/lib/hooks/use-i18n';
import { questionBankApi } from '@/lib/study/assessments/client';
import type { QuestionPack, QuestionPackSummary } from '@/lib/study/questions/packs';

export function OfficialPacksDialog({
  open,
  onOpenChange,
  spaceId,
  archived,
  onCopied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaceId: string;
  archived: boolean;
  onCopied: () => void;
}) {
  const { t } = useI18n();
  const [packs, setPacks] = useState<QuestionPackSummary[] | null>(null);
  const [current, setCurrent] = useState<{
    pack: QuestionPackSummary;
    questions: QuestionPack['questions'];
  } | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void questionBankApi
      .packs()
      .then(async (list) => {
        if (cancelled) return;
        setPacks(list);
        if (list[0]) {
          const first = await questionBankApi.pack(list[0].id);
          if (!cancelled) setCurrent(first);
        }
      })
      .catch(() => !cancelled && setPacks([]));
    return () => {
      cancelled = true;
    };
  }, []);

  async function copy() {
    if (!current) return;
    setBusy(true);
    try {
      const result = await questionBankApi.copyFromPack(current.pack.id, spaceId, [...chosen]);
      toast.success(
        t('study.practice.packs.copied', {
          created: result.created,
          duplicates: result.duplicates,
        }),
      );
      setChosen(new Set());
      onCopied();
    } catch {
      toast.error(t('study.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl"
        data-testid="official-packs"
      >
        <DialogHeader>
          <DialogTitle>{t('study.practice.packs.title')}</DialogTitle>
          <DialogDescription>{t('study.practice.packs.description')}</DialogDescription>
        </DialogHeader>

        {packs === null ? (
          <LoaderCircle className="mx-auto size-5 animate-spin text-muted-foreground" />
        ) : packs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('study.practice.packs.empty')}</p>
        ) : current ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
              <p className="font-medium text-foreground">
                {current.pack.title}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  v{current.pack.version}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('study.practice.packs.attribution', {
                  attribution: current.pack.attribution,
                  license: current.pack.license,
                })}
              </p>
            </div>
            <ul className="max-h-[50dvh] space-y-2 overflow-y-auto pr-1">
              {current.questions.map((question) => (
                <li
                  key={question.id}
                  className="flex items-start gap-3 rounded-xl border border-border p-3 text-sm"
                >
                  {!archived ? (
                    <Checkbox
                      className="mt-0.5"
                      checked={chosen.has(question.id)}
                      aria-label={t('study.practice.packs.choose')}
                      onCheckedChange={(checked) =>
                        setChosen((set) => {
                          const next = new Set(set);
                          if (checked === true) next.add(question.id);
                          else next.delete(question.id);
                          return next;
                        })
                      }
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <QuizMathText text={question.stem} />
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <TypeChip type={question.type} />
                      {question.concepts.map((name) => (
                        <span key={name} className="text-xs text-muted-foreground">
                          #{name}
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <LoaderCircle className="mx-auto size-5 animate-spin text-muted-foreground" />
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          {!archived ? (
            <Button disabled={busy || chosen.size === 0} onClick={() => void copy()}>
              <Copy className="mr-1 size-4" />
              {t('study.practice.packs.copy', { count: chosen.size })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
