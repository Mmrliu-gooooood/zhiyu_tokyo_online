'use client';

/**
 * /study/memory — what the system keeps about the student (learning plan
 * B06), grouped as preferences, facts (what they told us, subject goals and
 * learning records) and recent state, each with its source and time. The
 * student can correct, delete, clear, and switch personalisation off
 * globally or per subject. Learning records describe what happened (watched,
 * submitted, asked); nothing here claims mastery.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Brain, ChevronLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
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
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  addFact,
  clearMemoryParts,
  correctFact,
  fetchMemoryOverview,
  removeFact,
  removeLearningRecord,
  removePreference,
  savePreference,
  setMemorySwitch,
} from '@/lib/study/memory/client';
import {
  MEMORY_LIMITS,
  PREFERENCE_CHOICES,
  type ChoicePreferenceKey,
  type FactView,
  type LearningRecordView,
  type PreferenceView,
} from '@/lib/study/memory/contracts';
import type { MemoryOverview } from '@/lib/study/memory/overview';
import type { RecentState } from '@/lib/study/memory/recent-state';
import { StudyApiError, fetchStudyCapabilities } from '@/lib/study/spaces/client';

const CHOICE_KEYS = Object.keys(PREFERENCE_CHOICES) as ChoicePreferenceKey[];

function formatTime(value: string): string {
  const date = new Date(value);
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(
    date.getHours(),
  ).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function Section({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className="mt-8" data-testid={testId}>
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {hint ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function MemoryPage() {
  const { t } = useI18n();
  const [state, setState] = useState<StudyLoadState>('loading');
  const [data, setData] = useState<MemoryOverview | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<string>('');
  const [goalDraft, setGoalDraft] = useState('');
  const [factDraft, setFactDraft] = useState('');
  const [factScope, setFactScope] = useState('');
  const [editingFact, setEditingFact] = useState<{ id: string; text: string } | null>(null);
  const [correcting, setCorrecting] = useState<{ key: string; text: string } | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearParts, setClearParts] = useState({
    preferences: true,
    facts: true,
    records: true,
    rawQuizAttempts: false,
  });

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      const capabilities = await fetchStudyCapabilities();
      if (!capabilities.memory) throw Object.assign(new Error('unavailable'), { status: 404 });
      return fetchMemoryOverview();
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') setData(result.data);
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [loadKey]);

  const refresh = () => setLoadKey((key) => key + 1);
  const scopeSpaceId = scope || null;

  const preferenceFor = (key: string, spaceId: string | null): PreferenceView | undefined =>
    data?.preferences.find((item) => item.key === key && item.spaceId === spaceId);

  useEffect(() => {
    setGoalDraft(preferenceFor('learning_goal', scopeSpaceId)?.value ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, scope]);

  const spaceName = useMemo(() => {
    const names = new Map((data?.spaces ?? []).map((space) => [space.spaceId, space.name]));
    return (spaceId: string | null) => (spaceId ? (names.get(spaceId) ?? '') : '');
  }, [data]);

  const errorText = (error: unknown) => {
    const code = error instanceof StudyApiError ? error.code : '';
    const key = `study.memory.errors.${code}`;
    const translated = t(key);
    return translated !== key ? translated : t('study.errors.generic');
  };

  async function run(action: () => Promise<unknown>, success?: string) {
    setBusy(true);
    try {
      await action();
      if (success) toast.success(success);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  if (state !== 'ready' || !data) {
    return (
      <StudyShell>
        <StudyStatus
          state={state === 'ready' ? 'loading' : state}
          onRetry={() => {
            setState('loading');
            refresh();
          }}
        />
      </StudyShell>
    );
  }

  const globalOn = data.controls.global.enabled;
  const activeSpaces = data.spaces.filter((space) => space.status === 'active');
  const userFacts = data.facts.filter((fact) => fact.origin !== 'correction');

  const originText = (item: { origin: string; updatedAt: string }) =>
    `${t(`study.memory.origin.${item.origin}`)} · ${formatTime(item.updatedAt)}`;

  const recordText = (record: LearningRecordView): string => {
    const course = record.course?.title ?? t('study.memory.record.unknownCourse');
    const payload = record.payload as Record<string, unknown>;
    switch (record.type) {
      case 'course_started':
        return t('study.memory.record.courseStarted', { course });
      case 'course_progressed':
        return t('study.memory.record.courseProgressed', {
          course,
          page: Number(payload.furthestPage ?? 0),
          count: Number(payload.pageCount ?? 0),
        });
      case 'course_finished':
        return t('study.memory.record.courseFinished', {
          course,
          count: Number(payload.pageCount ?? 0),
        });
      case 'quiz_submitted':
        return t('study.memory.record.quizSubmitted', {
          course,
          count: Number(payload.questionCount ?? 0),
        });
      case 'quiz_graded':
        return t('study.memory.record.quizGraded', { course });
      case 'companion_question':
        return t('study.memory.record.companionQuestion', {
          space: spaceName(record.spaceIds[0] ?? null) || t('study.memory.record.unknownSpace'),
          classmate: record.classmate?.name ?? t('study.memory.record.unknownClassmate'),
          preview: String(payload.preview ?? ''),
        });
      default:
        return t(`study.memory.record.${record.type}`);
    }
  };

  const recordDetail = (record: LearningRecordView): string | null => {
    const payload = record.payload as Record<string, unknown>;
    if (record.type.startsWith('course_')) return t('study.memory.record.viewingOnly');
    if (record.type !== 'quiz_graded') return null;
    const parts: string[] = [];
    const objective = payload.objective as { correct?: number; total?: number } | null;
    if (payload.verification === 'server_checked' && objective) {
      parts.push(
        t('study.memory.record.objectiveChecked', {
          correct: objective.correct ?? 0,
          total: objective.total ?? 0,
        }),
      );
    } else {
      parts.push(t('study.memory.record.objectiveUnverified'));
    }
    const ai = payload.aiGraded as { earned?: number; points?: number } | null;
    if (ai) {
      parts.push(
        t('study.memory.record.aiGraded', { earned: ai.earned ?? 0, points: ai.points ?? 0 }),
      );
    }
    return parts.join(' · ');
  };

  const recentLines = (recent: RecentState): string[] => {
    const lines: string[] = [];
    if (recent.coursesViewed) {
      lines.push(
        t('study.memory.recent.courses', {
          viewed: recent.coursesViewed,
          finished: recent.coursesFinished,
        }),
      );
      for (const item of recent.courseProgress.slice(0, 3)) {
        lines.push(
          t('study.memory.recent.progress', {
            course: data.names.courses[item.stageId] ?? t('study.memory.record.unknownCourse'),
            page: item.furthestPage,
            count: item.pageCount,
          }),
        );
      }
    }
    if (recent.quizzesSubmitted || recent.quizzesGraded) {
      lines.push(
        t('study.memory.recent.quizzes', {
          submitted: recent.quizzesSubmitted,
          graded: recent.quizzesGraded,
        }) +
          (recent.objective.total
            ? ` · ${t('study.memory.recent.objective', recent.objective)}`
            : '') +
          (recent.quizzesUnverified
            ? ` · ${t('study.memory.recent.unverified', { count: recent.quizzesUnverified })}`
            : ''),
      );
    }
    if (recent.companionQuestions) {
      lines.push(
        t('study.memory.recent.companion', {
          count: recent.companionQuestions,
          detail: recent.companionByClassmate
            .slice(0, 3)
            .map((item) => `${data.names.classmates[item.classmateId] ?? '?'} ${item.count}`)
            .join('、'),
        }),
      );
    }
    return lines;
  };

  const choiceRow = (key: ChoicePreferenceKey) => {
    const own = preferenceFor(key, scopeSpaceId);
    const inherited = scopeSpaceId ? preferenceFor(key, null) : undefined;
    return (
      <div
        key={key}
        className="rounded-xl border border-border bg-card p-3"
        data-testid={`pref-${key}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{t(`study.memory.pref.${key}`)}</span>
          {own ? (
            <span className="text-[11px] text-muted-foreground">{originText(own)}</span>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant={own ? 'ghost' : 'secondary'}
            disabled={busy || !own}
            onClick={() =>
              void run(() => removePreference(key, scopeSpaceId), t('study.memory.pref.cleared'))
            }
            data-testid={`pref-${key}-unset`}
          >
            {scopeSpaceId
              ? t('study.memory.pref.followGlobal', {
                  value: inherited
                    ? t(`study.memory.choice.${key}.${inherited.value}`)
                    : t('study.memory.pref.notSet'),
                })
              : t('study.memory.pref.notSet')}
          </Button>
          {PREFERENCE_CHOICES[key].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={own?.value === value ? 'default' : 'outline'}
              disabled={busy}
              onClick={() =>
                void run(() =>
                  savePreference({ key, value, spaceId: scopeSpaceId, origin: 'settings' }),
                )
              }
              data-testid={`pref-${key}-${value}`}
            >
              {t(`study.memory.choice.${key}.${value}`)}
            </Button>
          ))}
        </div>
        {own?.origin === 'confirmed_prompt' && own.evidence?.excerpt ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {t('study.memory.pref.evidence', { excerpt: own.evidence.excerpt })}
          </p>
        ) : null}
      </div>
    );
  };

  const factItem = (fact: FactView) => (
    <li
      key={fact.id}
      className="flex items-start gap-2 rounded-xl border border-border bg-card px-3 py-2"
      data-testid="memory-fact"
    >
      <div className="min-w-0 flex-1">
        {editingFact?.id === fact.id ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() =>
                correctFact(fact.id, { text: editingFact.text, baseRevision: fact.revision }),
              ).then(() => setEditingFact(null));
            }}
          >
            <input
              value={editingFact.text}
              maxLength={MEMORY_LIMITS.factChars}
              onChange={(event) => setEditingFact({ id: fact.id, text: event.target.value })}
              className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm"
            />
            <Button size="sm" type="submit" disabled={busy || !editingFact.text.trim()}>
              {t('study.memory.save')}
            </Button>
          </form>
        ) : (
          <p className="text-sm">{fact.text}</p>
        )}
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {(fact.spaceId ? spaceName(fact.spaceId) : t('study.memory.allSubjects')) + ' · '}
          {originText(fact)}
        </p>
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        aria-label={t('study.memory.correct')}
        onClick={() => setEditingFact({ id: fact.id, text: fact.text })}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        aria-label={t('study.memory.delete')}
        disabled={busy}
        onClick={() => void run(() => removeFact(fact.id), t('study.memory.deleted'))}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );

  const recordItem = (record: LearningRecordView) => {
    const detail = recordDetail(record);
    return (
      <li
        key={record.seq}
        className="flex items-start gap-2 rounded-xl border border-border bg-card px-3 py-2"
        data-testid="memory-record"
        data-record-type={record.type}
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm">{recordText(record)}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {[
              record.spaceIds
                .map((id) => spaceName(id))
                .filter(Boolean)
                .join('、'),
              t(`study.memory.source.${record.sourceType}`),
              formatTime(record.occurredAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {detail ? (
            <p
              className="mt-0.5 text-[11px] text-muted-foreground"
              data-testid="memory-record-detail"
            >
              {detail}
            </p>
          ) : null}
          {record.correction ? (
            <p className="mt-1 text-xs text-primary" data-testid="memory-record-correction">
              {t('study.memory.correction', { text: record.correction.text })}
            </p>
          ) : null}
          {correcting?.key === record.sourceKey ? (
            <form
              className="mt-1.5 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run(() =>
                  addFact({
                    text: correcting.text,
                    spaceId: null,
                    correctsKey: record.sourceKey,
                  }),
                ).then(() => setCorrecting(null));
              }}
            >
              <input
                value={correcting.text}
                maxLength={MEMORY_LIMITS.factChars}
                placeholder={t('study.memory.correctionPlaceholder')}
                onChange={(event) =>
                  setCorrecting({ key: record.sourceKey, text: event.target.value })
                }
                className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-sm"
              />
              <Button size="sm" type="submit" disabled={busy || !correcting.text.trim()}>
                {t('study.memory.save')}
              </Button>
            </form>
          ) : null}
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={t('study.memory.correct')}
          onClick={() =>
            setCorrecting({ key: record.sourceKey, text: record.correction?.text ?? '' })
          }
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={t('study.memory.delete')}
          disabled={busy}
          onClick={() =>
            void run(() => removeLearningRecord(record.seq), t('study.memory.recordDeleted'))
          }
          data-testid="memory-record-delete"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </li>
    );
  };

  const recentCard = (recent: RecentState, title: string) => {
    const lines = recentLines(recent);
    return (
      <div
        key={recent.spaceId ?? 'all'}
        className="rounded-xl border border-border bg-card p-3"
        data-testid="memory-recent"
      >
        <p className="text-sm font-medium">{title}</p>
        {lines.length ? (
          <ul className="mt-1.5 space-y-0.5 text-xs leading-5 text-muted-foreground">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">{t('study.memory.recent.empty')}</p>
        )}
      </div>
    );
  };

  return (
    <StudyShell>
      <Link
        href="/study"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t('study.backToSpaces')}
      </Link>
      <header className="mb-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-[-0.02em] text-foreground md:text-3xl">
            <Brain className="size-6 text-primary" />
            {t('study.memory.title')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
            {t('study.memory.subtitle')}
          </p>
        </div>
        <Button variant="outline" onClick={() => setClearOpen(true)} data-testid="memory-clear">
          <Trash2 className="mr-1.5 size-4" />
          {t('study.memory.clear.open')}
        </Button>
      </header>

      <div
        className="mt-4 rounded-2xl border border-border bg-card p-4"
        data-testid="memory-switches"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium">{t('study.memory.switch.global')}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {globalOn ? t('study.memory.switch.onHint') : t('study.memory.switch.offHint')}
            </p>
          </div>
          <Switch
            checked={globalOn}
            disabled={busy}
            aria-label={t('study.memory.switch.global')}
            data-testid="memory-switch-global"
            onCheckedChange={(enabled) =>
              void run(() => setMemorySwitch(null, enabled, data.controls.global.revision))
            }
          />
        </div>
        {activeSpaces.length ? (
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-2 text-xs text-muted-foreground">
              {t('study.memory.switch.perSpace')}
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {data.controls.spaces
                .filter((control) => control.status === 'active')
                .map((control) => (
                  <li
                    key={control.spaceId}
                    className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-1.5 text-sm"
                  >
                    <span className="truncate">{control.name}</span>
                    <Switch
                      checked={control.enabled}
                      disabled={busy || !globalOn}
                      aria-label={control.name}
                      data-testid={`memory-switch-${control.spaceId}`}
                      onCheckedChange={(enabled) =>
                        void run(() => setMemorySwitch(control.spaceId, enabled, control.revision))
                      }
                    />
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
      </div>

      <Section
        title={t('study.memory.sections.preferences')}
        hint={t('study.memory.prefHint')}
        testId="memory-preferences"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('study.memory.scope')}</span>
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            data-testid="memory-scope"
          >
            <option value="">{t('study.memory.allSubjects')}</option>
            {activeSpaces.map((space) => (
              <option key={space.spaceId} value={space.spaceId}>
                {space.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-3 md:grid-cols-3">{CHOICE_KEYS.map(choiceRow)}</div>
        <form
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3"
          onSubmit={(event) => {
            event.preventDefault();
            const text = goalDraft.trim();
            void run(() =>
              text
                ? savePreference({
                    key: 'learning_goal',
                    value: text,
                    spaceId: scopeSpaceId,
                    origin: 'settings',
                  })
                : removePreference('learning_goal', scopeSpaceId),
            );
          }}
        >
          <span className="text-sm font-medium">{t('study.memory.pref.learning_goal')}</span>
          <input
            value={goalDraft}
            maxLength={MEMORY_LIMITS.goalChars}
            onChange={(event) => setGoalDraft(event.target.value)}
            placeholder={t('study.memory.goalPlaceholder')}
            className="h-8 min-w-[12rem] flex-1 rounded-md border border-border bg-background px-2 text-sm"
            data-testid="memory-goal"
          />
          <Button size="sm" type="submit" disabled={busy}>
            {t('study.memory.save')}
          </Button>
        </form>
      </Section>

      <Section
        title={t('study.memory.sections.facts')}
        hint={t('study.memory.factHint')}
        testId="memory-facts"
      >
        <h3 className="mb-2 text-sm font-medium text-muted-foreground">
          {t('study.memory.toldUs')}
        </h3>
        <form
          className="mb-2 flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => addFact({ text: factDraft, spaceId: factScope || null })).then(() =>
              setFactDraft(''),
            );
          }}
        >
          <input
            value={factDraft}
            maxLength={MEMORY_LIMITS.factChars}
            onChange={(event) => setFactDraft(event.target.value)}
            placeholder={t('study.memory.factPlaceholder')}
            className="h-9 min-w-[14rem] flex-1 rounded-md border border-border bg-background px-2 text-sm"
            data-testid="memory-fact-input"
          />
          <select
            value={factScope}
            onChange={(event) => setFactScope(event.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">{t('study.memory.allSubjects')}</option>
            {activeSpaces.map((space) => (
              <option key={space.spaceId} value={space.spaceId}>
                {space.name}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" className="h-9" disabled={busy || !factDraft.trim()}>
            <Plus className="mr-1 size-4" />
            {t('study.memory.add')}
          </Button>
        </form>
        {userFacts.length ? (
          <ul className="space-y-2">{userFacts.map(factItem)}</ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t('study.memory.noFacts')}</p>
        )}

        {data.spaces.some((space) => space.goal || space.examDate) ? (
          <>
            <h3 className="mb-2 mt-5 text-sm font-medium text-muted-foreground">
              {t('study.memory.spaceGoals')}
            </h3>
            <ul className="space-y-1.5 text-sm">
              {data.spaces
                .filter((space) => space.goal || space.examDate)
                .map((space) => (
                  <li
                    key={space.spaceId}
                    className="rounded-xl border border-border bg-card px-3 py-2"
                  >
                    <span className="font-medium">{space.name}</span>
                    {space.goal ? ` · ${space.goal}` : ''}
                    {space.examDate
                      ? ` · ${t('study.memory.examDate', { date: space.examDate })}`
                      : ''}
                    <Link
                      href={`/study/${encodeURIComponent(space.spaceId)}`}
                      className="ml-2 text-xs text-muted-foreground underline underline-offset-2"
                    >
                      {t('study.memory.editInSpace')}
                    </Link>
                  </li>
                ))}
            </ul>
          </>
        ) : null}

        <h3 className="mb-1 mt-5 text-sm font-medium text-muted-foreground">
          {t('study.memory.records')}
        </h3>
        <p className="mb-2 text-[11px] leading-5 text-muted-foreground">
          {globalOn ? t('study.memory.recordsHint') : t('study.memory.recordsPaused')}
        </p>
        {data.records.length ? (
          <ul className="space-y-2">{data.records.map(recordItem)}</ul>
        ) : (
          <p className="text-xs text-muted-foreground">{t('study.memory.noRecords')}</p>
        )}
      </Section>

      <Section
        title={t('study.memory.sections.recent')}
        hint={t('study.memory.recentHint', { days: data.recentState.all.windowDays })}
        testId="memory-recent-section"
      >
        <div className="grid gap-3 md:grid-cols-2">
          {recentCard(data.recentState.all, t('study.memory.allSubjects'))}
          {data.recentState.spaces.map((recent) => recentCard(recent, spaceName(recent.spaceId)))}
        </div>
      </Section>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('study.memory.clear.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('study.memory.clear.text')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-sm" data-testid="memory-clear-options">
            {(['preferences', 'facts', 'records', 'rawQuizAttempts'] as const).map((part) => (
              <label key={part} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={clearParts[part]}
                  onChange={(event) =>
                    setClearParts((parts) => ({ ...parts, [part]: event.target.checked }))
                  }
                  data-testid={`memory-clear-${part}`}
                />
                <span>
                  {t(`study.memory.clear.${part}`)}
                  {part === 'rawQuizAttempts' ? (
                    <span className="block text-xs text-muted-foreground">
                      {t('study.memory.clear.rawHint')}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!Object.values(clearParts).some(Boolean)}
              data-testid="memory-clear-confirm"
              onClick={() =>
                void run(() => clearMemoryParts(clearParts), t('study.memory.clear.done'))
              }
            >
              {t('study.memory.clear.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </StudyShell>
  );
}
