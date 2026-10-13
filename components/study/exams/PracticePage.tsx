'use client';

/**
 * /study/[spaceId]/practice — a subject's question bank and tests (learning
 * plan B07): the bank, building a paper by rule, and the paper history.
 * Testing is voluntary; nothing here gates finishing a course.
 * `?tab=build&course=<stageId>` opens the builder for one course.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PaperBuilderPanel } from '@/components/study/exams/PaperBuilderPanel';
import { PapersPanel } from '@/components/study/exams/PapersPanel';
import { QuestionBankPanel } from '@/components/study/exams/QuestionBankPanel';
import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import { useI18n } from '@/lib/hooks/use-i18n';
import { questionBankApi } from '@/lib/study/assessments/client';
import type { ConceptView } from '@/lib/study/questions/contracts';
import { fetchStudyCapabilities, studyApi } from '@/lib/study/spaces/client';
import type { StudySpaceDetail } from '@/lib/study/spaces/contracts';

const TABS = ['bank', 'build', 'papers'] as const;
type Tab = (typeof TABS)[number];

export function PracticePage({ spaceId }: { spaceId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const search = useSearchParams();
  const requested = search.get('tab');
  const [tab, setTab] = useState<Tab>(
    (TABS as readonly string[]).includes(requested ?? '') ? (requested as Tab) : 'bank',
  );
  const [state, setState] = useState<StudyLoadState>('loading');
  const [space, setSpace] = useState<StudySpaceDetail | null>(null);
  const [concepts, setConcepts] = useState<ConceptView[]>([]);
  const [canExtract, setCanExtract] = useState(false);
  const [canGrade, setCanGrade] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      const capabilities = await fetchStudyCapabilities();
      if (!capabilities.exams) {
        throw Object.assign(new Error('unavailable'), { status: 404 });
      }
      if (!cancelled) {
        setCanExtract(capabilities.extraction);
        setCanGrade(capabilities.grading);
      }
      return studyApi.getSpace(spaceId);
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') setSpace(result.data);
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [spaceId, loadKey]);

  const loadConcepts = useCallback(() => {
    void questionBankApi
      .concepts(spaceId)
      .then(setConcepts)
      .catch(() => setConcepts([]));
  }, [spaceId]);

  useEffect(() => {
    if (state === 'ready') loadConcepts();
  }, [state, loadConcepts]);

  if (state !== 'ready' || !space) {
    return (
      <StudyShell>
        <StudyStatus
          state={state === 'ready' ? 'loading' : state}
          onRetry={() => {
            setState('loading');
            setLoadKey((key) => key + 1);
          }}
        />
      </StudyShell>
    );
  }

  const archived = space.status === 'archived';
  const courses = space.courses.map((course) => ({ stageId: course.stageId, name: course.name }));

  return (
    <StudyShell>
      <Link
        href={`/study/${encodeURIComponent(space.id)}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {space.name}
      </Link>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground md:text-3xl">
          {t('study.practice.title')}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t('study.practice.subtitle')}</p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as Tab);
          const params = new URLSearchParams(search.toString());
          params.set('tab', value);
          router.replace(`?${params.toString()}`, { scroll: false });
        }}
      >
        <TabsList className="mb-5">
          <TabsTrigger value="bank" data-testid="practice-tab-bank">
            {t('study.practice.tabs.bank')}
          </TabsTrigger>
          <TabsTrigger value="build" data-testid="practice-tab-build">
            {t('study.practice.tabs.build')}
          </TabsTrigger>
          <TabsTrigger value="papers" data-testid="practice-tab-papers">
            {t('study.practice.tabs.papers')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="bank">
          <QuestionBankPanel
            spaceId={space.id}
            archived={archived}
            courses={courses}
            concepts={concepts}
            canExtract={canExtract}
            onBankChanged={loadConcepts}
          />
        </TabsContent>
        <TabsContent value="build">
          <PaperBuilderPanel
            spaceId={space.id}
            spaceName={space.name}
            archived={archived}
            courses={courses}
            concepts={concepts}
            initialCourse={search.get('course')}
            allowOpen={canGrade}
          />
        </TabsContent>
        <TabsContent value="papers">
          <PapersPanel spaceId={space.id} archived={archived} />
        </TabsContent>
      </Tabs>
    </StudyShell>
  );
}
