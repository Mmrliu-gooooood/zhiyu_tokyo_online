'use client';

/**
 * Build a paper by rule (learning plan B07): how many of each type, which
 * knowledge points and course, difficulty, skipping questions already done,
 * unchecked questions and official packs. The preview shows the exact
 * questions and every shortfall; publishing freezes that preview (same seed)
 * and opens the first attempt. No model is used for a bank paper.
 *
 * With AI practice (B11) the student may instead choose "bank first, AI for
 * the gap" or "all by AI": the preview then carries the generation plan,
 * which the student confirms before any model call (GenerationPanel).
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, LoaderCircle, Play, Shuffle } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  OriginChip,
  TypeChip,
  VerificationChip,
  newRequestKey,
  MathText,
} from '@/components/study/exams/exam-format';
import type { EditorCourse } from '@/components/study/exams/QuestionEditorDialog';
import { useI18n } from '@/lib/hooks/use-i18n';
import { examsApi, questionBankApi, type BlueprintRequest } from '@/lib/study/assessments/client';
import {
  BLUEPRINT_LIMITS,
  type DifficultyPreference,
  type PaperPreview,
} from '@/lib/study/questions/blueprint';
import type { ConceptView, QuestionType } from '@/lib/study/questions/contracts';
import type { QuestionPackSummary } from '@/lib/study/questions/packs';
import { GenerationPanel } from '@/components/study/practice/GenerationPanel';
import { practiceApi, type PracticePreview } from '@/lib/study/practice/client';
import type { PracticeMode } from '@/lib/study/practice/contracts';
import { StudyApiError } from '@/lib/study/spaces/client';
import { cn } from '@/lib/utils';

const ANY_COURSE = '__any__';

type BuildMode = 'bank' | PracticeMode;
const MODES: readonly BuildMode[] = ['bank', 'mixed', 'ai'];

interface Form {
  single: string;
  multiple: string;
  /** Open questions (B09), only when assisted grading is on. */
  short_answer: string;
  conceptIds: string[];
  stageId: string;
  difficulty: DifficultyPreference;
  avoidSeen: boolean;
  includeUnverified: boolean;
  includePublic: boolean;
  packIds: string[];
  title: string;
}

function count(value: string): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0
    ? Math.min(number, BLUEPRINT_LIMITS.maxPerSection)
    : 0;
}

export function PaperBuilderPanel({
  spaceId,
  spaceName,
  archived,
  courses,
  concepts,
  initialCourse,
  allowOpen = false,
  allowPractice = false,
}: {
  spaceId: string;
  spaceName: string;
  archived: boolean;
  courses: EditorCourse[];
  concepts: ConceptView[];
  initialCourse: string | null;
  /** Whether papers may contain open questions (assisted grading on). */
  allowOpen?: boolean;
  /** Whether AI top-ups and AI papers are offered (B11). */
  allowPractice?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [packs, setPacks] = useState<QuestionPackSummary[]>([]);
  const [form, setForm] = useState<Form>({
    single: '8',
    multiple: '2',
    short_answer: '0',
    conceptIds: [],
    stageId:
      initialCourse && courses.some((course) => course.stageId === initialCourse)
        ? initialCourse
        : ANY_COURSE,
    difficulty: 'any',
    avoidSeen: false,
    includeUnverified: false,
    includePublic: true,
    packIds: [],
    title: '',
  });
  const [mode, setMode] = useState<BuildMode>('bank');
  const [preview, setPreview] = useState<PaperPreview | PracticePreview | null>(null);
  /** One key per preview for the AI job (a retried start never creates a second job). */
  const [jobKey, setJobKey] = useState(newRequestKey);
  /** One key per shown preview: retrying a publish never creates a second paper. */
  const [publishKey, setPublishKey] = useState(newRequestKey);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void questionBankApi
      .packs()
      .then(setPacks)
      .catch(() => setPacks([]));
  }, []);

  const types: QuestionType[] = allowOpen
    ? ['single', 'multiple', 'short_answer']
    : ['single', 'multiple'];
  const total = types.reduce((sum, type) => sum + count(form[type]), 0);
  const defaultTitle = t('study.practice.build.defaultTitle', { space: spaceName, count: total });
  const usableConcepts = concepts.filter((concept) => concept.questionCount > 0);
  const conceptName = useMemo(
    () => new Map(concepts.map((concept) => [concept.id, concept.name])),
    [concepts],
  );

  const update = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key !== 'title') setPreview(null);
  };
  const toggle = (key: 'conceptIds' | 'packIds', id: string) =>
    update(
      key,
      form[key].includes(id) ? form[key].filter((value) => value !== id) : [...form[key], id],
    );

  function blueprint(seed?: string): BlueprintRequest {
    const sections = types
      .map((type) => ({ type, count: count(form[type]) }))
      .filter((section) => section.count > 0);
    return {
      spaceId,
      sections,
      conceptIds: form.conceptIds,
      stageId: form.stageId === ANY_COURSE ? null : form.stageId,
      difficulty: form.difficulty,
      avoidSeen: form.avoidSeen,
      includeUnverified: form.includeUnverified,
      includePublic: form.includePublic,
      packIds: form.packIds,
      ...(seed ? { seed } : {}),
    };
  }

  async function showPreview() {
    if (total === 0) return;
    setBusy(true);
    try {
      setPreview(
        mode === 'bank'
          ? await examsApi.preview(blueprint())
          : await practiceApi.preview(blueprint(), mode),
      );
      setPublishKey(newRequestKey());
      setJobKey(newRequestKey());
    } catch {
      toast.error(t('study.errors.generic'));
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!preview?.complete) return;
    setBusy(true);
    try {
      const paper = await examsApi.publish(
        { ...blueprint(), seed: preview.seed },
        form.title.trim() || defaultTitle,
        publishKey,
      );
      const attempt = await examsApi.start(paper.id);
      router.push(
        `/study/${encodeURIComponent(spaceId)}/attempts/${encodeURIComponent(attempt.id)}`,
      );
    } catch (error) {
      if (error instanceof StudyApiError && error.code === 'STUDY_EXAM_INSUFFICIENT') {
        toast.error(t('study.practice.build.changed'));
        setPreview(null);
      } else {
        toast.error(t('study.errors.generic'));
      }
      setBusy(false);
    }
  }

  const shortfallText = (shortfall: PaperPreview['shortfalls'][number]) => {
    const parts = [
      t('study.practice.build.shortfall', {
        type: t(`study.practice.type.${shortfall.type}`),
        wanted: shortfall.wanted,
        available: shortfall.available,
      }),
    ];
    if (shortfall.excludedSeen) {
      parts.push(t('study.practice.build.excludedSeen', { count: shortfall.excludedSeen }));
    }
    if (shortfall.excludedUnverified) {
      parts.push(
        t('study.practice.build.excludedUnverified', { count: shortfall.excludedUnverified }),
      );
    }
    return parts.join(' ');
  };

  const generation = preview && 'generation' in preview ? preview.generation : null;
  // A mixed paper whose bank already fills every section publishes like a bank paper.
  const needsAi = Boolean(generation && generation.blocked !== 'nothing_to_generate');
  const aiOnly = mode === 'ai';

  return (
    <section className="space-y-6" data-testid="paper-builder">
      {allowPractice ? (
        <div className="space-y-2">
          <Label>{t('study.practice.ai.mode.label')}</Label>
          <div className="flex flex-wrap gap-1.5" role="radiogroup">
            {MODES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                data-testid={`build-mode-${value}`}
                onClick={() => {
                  setMode(value);
                  setPreview(null);
                }}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-colors',
                  mode === value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50',
                )}
              >
                {t(`study.practice.ai.mode.${value}`)}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t(`study.practice.ai.modeHint.${mode}`)}</p>
        </div>
      ) : null}
      <div className={cn('grid gap-4', allowOpen ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        {types.map((type) => (
          <div key={type} className="space-y-1.5">
            <Label htmlFor={`build-${type}`}>
              {t('study.practice.build.countOf', { type: t(`study.practice.type.${type}`) })}
            </Label>
            <Input
              id={`build-${type}`}
              data-testid={`build-count-${type}`}
              type="number"
              min={0}
              max={BLUEPRINT_LIMITS.maxPerSection}
              value={form[type]}
              onChange={(event) => update(type, event.target.value)}
            />
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <Label>{t('study.practice.build.concepts')}</Label>
        {usableConcepts.length ? (
          <div className="flex flex-wrap gap-1.5">
            {usableConcepts.map((concept) => (
              <button
                key={concept.id}
                type="button"
                aria-pressed={form.conceptIds.includes(concept.id)}
                onClick={() => toggle('conceptIds', concept.id)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition-colors',
                  form.conceptIds.includes(concept.id)
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/50',
                )}
              >
                {concept.name}
                <span className="ml-1 opacity-60">{concept.questionCount}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('study.practice.build.noConcepts')}</p>
        )}
        <p className="text-xs text-muted-foreground">{t('study.practice.build.conceptsHint')}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t('study.practice.editor.course')}</Label>
          <Select value={form.stageId} onValueChange={(value) => update('stageId', value)}>
            <SelectTrigger className="w-full" data-testid="build-course">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_COURSE}>{t('study.practice.build.anyCourse')}</SelectItem>
              {courses.map((course) => (
                <SelectItem key={course.stageId} value={course.stageId}>
                  {course.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t('study.practice.editor.difficulty')}</Label>
          <Select
            value={form.difficulty}
            onValueChange={(value) => update('difficulty', value as DifficultyPreference)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{t('study.practice.build.difficultyAny')}</SelectItem>
              <SelectItem value="easier">{t('study.practice.build.difficultyEasier')}</SelectItem>
              <SelectItem value="harder">{t('study.practice.build.difficultyHarder')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.avoidSeen}
            onCheckedChange={(checked) => update('avoidSeen', checked === true)}
          />
          {t('study.practice.build.avoidSeen')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.includeUnverified}
            onCheckedChange={(checked) => update('includeUnverified', checked === true)}
          />
          {t('study.practice.build.includeUnverified')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.includePublic}
            onCheckedChange={(checked) => update('includePublic', checked === true)}
          />
          {t('study.practice.build.includePublic')}
        </label>
        {packs.map((pack) => (
          <label key={pack.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.packIds.includes(pack.id)}
              onCheckedChange={() => toggle('packIds', pack.id)}
              data-testid="build-pack"
            />
            {t('study.practice.build.usePack', { title: pack.title, count: pack.questionCount })}
          </label>
        ))}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="build-title">{t('study.practice.build.title')}</Label>
        <Input
          id="build-title"
          value={form.title}
          maxLength={BLUEPRINT_LIMITS.title}
          placeholder={defaultTitle}
          onChange={(event) => update('title', event.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy || total === 0}
          onClick={() => void showPreview()}
          data-testid="build-preview"
        >
          {busy && !preview ? (
            <LoaderCircle className="mr-1 size-4 animate-spin" />
          ) : preview ? (
            <Shuffle className="mr-1 size-4" />
          ) : (
            <Eye className="mr-1 size-4" />
          )}
          {preview ? t('study.practice.build.reshuffle') : t('study.practice.build.preview')}
        </Button>
        {!needsAi && !aiOnly ? (
          <Button
            disabled={busy || archived || !preview?.complete}
            onClick={() => void publish()}
            data-testid="build-publish"
          >
            <Play className="mr-1 size-4" />
            {t('study.practice.build.publish')}
          </Button>
        ) : null}
      </div>

      {preview && generation && (needsAi || aiOnly) ? (
        <GenerationPanel
          key={`${preview.seed}:${jobKey}`}
          plan={generation}
          selectableMaterials
          note={
            mode === 'mixed' && preview.items.length
              ? t('study.practice.ai.bankKept', { count: preview.items.length })
              : null
          }
          createJob={(materialVersionIds) =>
            practiceApi.createPaperJob({
              blueprint: { ...blueprint(), seed: preview.seed },
              mode: mode as PracticeMode,
              materialVersionIds,
              idempotencyKey: jobKey,
            })
          }
          paperTitle={form.title.trim() || defaultTitle}
          spaceId={spaceId}
          archived={archived}
        />
      ) : null}
      {generation?.blocked === 'nothing_to_generate' && preview?.uncoveredConceptIds.length ? (
        <p className="text-xs text-muted-foreground">
          {t('study.practice.ai.nothingButUncovered', {
            names: preview.uncoveredConceptIds
              .map((id) => conceptName.get(id) ?? id)
              .join(t('study.practice.separator')),
          })}
        </p>
      ) : null}

      {preview && !aiOnly ? (
        <div className="space-y-3" data-testid="build-result">
          {preview.complete ? (
            <p className="text-sm text-primary">
              {t('study.practice.build.ready', {
                count: preview.items.length,
                points: preview.totalPoints,
              })}
            </p>
          ) : (
            <div
              className="space-y-1 rounded-xl border border-review/30 bg-review-soft/60 p-3 text-sm text-review-ink"
              data-testid="build-gaps"
            >
              <p className="font-medium">{t('study.practice.build.gapsTitle')}</p>
              {preview.shortfalls.map((shortfall) => (
                <p key={shortfall.type}>{shortfallText(shortfall)}</p>
              ))}
              {preview.uncoveredConceptIds.length ? (
                <p>
                  {t('study.practice.build.uncovered', {
                    names: preview.uncoveredConceptIds
                      .map((id) => conceptName.get(id) ?? id)
                      .join(t('study.practice.separator')),
                  })}
                </p>
              ) : null}
              <p className="text-xs opacity-80">
                {mode === 'mixed'
                  ? t('study.practice.ai.gapsHintMixed')
                  : t('study.practice.build.gapsHint')}
              </p>
            </div>
          )}
          <ol className="space-y-2">
            {preview.items.map((item, index) => (
              <li key={item.ref} className="rounded-xl border border-border p-3 text-sm">
                <div className="flex gap-2">
                  <span className="w-6 shrink-0 text-xs text-muted-foreground">{index + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2">
                      <MathText text={item.stem} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <TypeChip type={item.type} subtype={item.subtype} />
                      <VerificationChip state={item.verification} />
                      {item.tier !== 'bank' ? <OriginChip origin={item.origin} /> : null}
                      {item.concepts.map((name) => (
                        <span key={name} className="text-[11px] text-muted-foreground">
                          #{name}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
