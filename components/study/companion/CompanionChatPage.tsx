'use client';

/**
 * /study/classmates/[classmateId]/chat — after-class chat with one classmate
 * (learning plan B05).
 *
 * Without `?session=` the page starts a new chat: the student picks the
 * study space (pre-selected when the classroom it came from belongs to
 * exactly one) and the classroom question arrives pre-filled. With a session
 * the page folds the session's durable event stream (resuming from the last
 * applied event id after a disconnect) and posts later questions through the
 * study API. Text answers are never read aloud automatically.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  BookOpen,
  ChevronLeft,
  Loader2,
  MessageSquarePlus,
  Search,
  Send,
  Square,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  StudyShell,
  StudyStatus,
  loadStudyPage,
  type StudyLoadState,
} from '@/components/study/spaces/StudyShell';
import {
  MemorySuggestionBar,
  MemoryTurnNote,
  useMemorySuggestions,
} from '@/components/study/memory/CompanionMemory';
import { QuizMathText } from '@/components/quiz/QuizMathText';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/hooks/use-i18n';
import { roleVoiceBinding } from '@/lib/audio/platform-tts-selection';
import { useSettingsStore } from '@/lib/store/settings';
import { classmateApi } from '@/lib/study/classmates/client';
import { CLASSMATE_PRESET_AVATARS, type ClassmateView } from '@/lib/study/classmates/contracts';
import { companionApi, type CompanionChatHeader } from '@/lib/study/companion/client';
import {
  COMPANION_LIMITS,
  excerptReaderHref,
  type CompanionChatView,
  type CompanionExcerpt,
  type CompanionOrigin,
} from '@/lib/study/companion/contracts';
import {
  COMPANION_EVENT_TYPES,
  companionErrorCode,
  createCompanionFold,
  foldCompanionEvent,
  type CompanionEvent,
  type CompanionNode,
} from '@/lib/study/companion/fold';
import { StudyApiError, fetchStudyCapabilities, studyApi } from '@/lib/study/spaces/client';
import { itemExplanationsHref } from '@/lib/study/explanations/client';
import type { StudySpaceSummary } from '@/lib/study/spaces/contracts';
import { cn } from '@/lib/utils';
import { whilePageVisible } from '@/lib/workbench/page-visible-lifecycle';
import { wrongbookApi } from '@/lib/study/wrongbook/client';
import type { WrongItemDetail } from '@/lib/study/wrongbook/contracts';
import { CompanionAnswer } from './CompanionAnswer';

interface PageData {
  classmate: ClassmateView;
  others: ClassmateView[];
  spaces: StudySpaceSummary[];
  chats: CompanionChatView[];
  originSpaces: string[];
  /** B06 Memory is served (preference confirm prompts, turn notes). */
  memory: boolean;
  /** B13 explanations on request: a chat about a wrong question links to them. */
  explanations: boolean;
  /** B10: the wrong item a new chat is opened from (its space is fixed). */
  wrongItem: WrongItemDetail | null;
}

const FALLBACK_AVATAR = CLASSMATE_PRESET_AVATARS[0];
const EMPTY_FOLD = createCompanionFold();

function Avatar({ src, color, size = 40 }: { src: string; color: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="relative inline-block shrink-0 overflow-hidden rounded-full ring-2"
      style={{ width: size, height: size, ['--tw-ring-color' as string]: `${color}66` }}
    >
      <img
        src={failed ? FALLBACK_AVATAR : src}
        alt=""
        className="size-full object-cover"
        onError={() => setFailed(true)}
        data-avatar-failed={failed ? '1' : undefined}
      />
    </span>
  );
}

function useCompanionStream(sessionId: string | null) {
  // The fold belongs to one session: switching sessions starts from scratch.
  const [state, setState] = useState(() => ({ sessionId, fold: createCompanionFold() }));
  const [connected, setConnected] = useState(false);
  // Bumped when the browser gives up on the stream (e.g. the server was
  // unreachable), so a fresh EventSource resumes from the last applied id.
  const [attempt, setAttempt] = useState(0);
  const fold = state.sessionId === sessionId ? state.fold : EMPTY_FOLD;
  // The resume point for a reconnect, read inside the stream effect.
  const foldRef = useRef(fold);
  useEffect(() => {
    foldRef.current = fold;
  }, [fold]);

  useEffect(() => {
    if (!sessionId) return;
    return whilePageVisible(() => {
      const from = foldRef.current.lastEventId;
      const source = new EventSource(
        `/api/agent/sessions/${encodeURIComponent(sessionId)}/events?lastEventId=${from}`,
      );
      const onEvent = (message: MessageEvent) => {
        let parsed: CompanionEvent;
        try {
          parsed = JSON.parse(message.data) as CompanionEvent;
        } catch {
          return;
        }
        setConnected(true);
        setState((previous) => ({
          sessionId,
          fold: foldCompanionEvent(
            previous.sessionId === sessionId ? previous.fold : createCompanionFold(),
            parsed,
          ),
        }));
      };
      const onCaughtUp = () => setConnected(true);
      for (const type of COMPANION_EVENT_TYPES)
        source.addEventListener(type, onEvent as EventListener);
      source.addEventListener('caught_up', onCaughtUp);
      let retry: ReturnType<typeof setTimeout> | undefined;
      source.onerror = () => {
        setConnected(false);
        if (source.readyState === EventSource.CLOSED) {
          retry = setTimeout(() => setAttempt((value) => value + 1), 3000);
        }
      };
      return () => {
        if (retry) clearTimeout(retry);
        for (const type of COMPANION_EVENT_TYPES)
          source.removeEventListener(type, onEvent as EventListener);
        source.removeEventListener('caught_up', onCaughtUp);
        source.onerror = null;
        source.close();
        setConnected(false);
      };
    });
  }, [sessionId, attempt]);

  return { fold, connected };
}

export function CompanionChatPage({ classmateId }: { classmateId: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const sessionId = params.get('session');
  const origin = useMemo<CompanionOrigin | null>(() => {
    // From the wrong-answer book (B10): only the item id; the server adds the question.
    const wrongItemId = params.get('wrong');
    if (wrongItemId) return { wrongItemId };
    const stageId = params.get('stage');
    if (!stageId) return null;
    const sceneId = params.get('scene') ?? undefined;
    const agentId = params.get('agent') ?? undefined;
    const excerpt = params.get('q') ?? undefined;
    return {
      stageId,
      ...(sceneId ? { sceneId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(excerpt
        ? { excerpt: Array.from(excerpt).slice(0, COMPANION_LIMITS.originExcerpt).join('') }
        : {}),
    };
  }, [params]);

  const [state, setState] = useState<StudyLoadState>('loading');
  const [data, setData] = useState<PageData | null>(null);
  const [header, setHeader] = useState<CompanionChatHeader | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const [spaceId, setSpaceId] = useState<string>(params.get('space') ?? '');
  const [draft, setDraft] = useState(() => params.get('q') ?? '');
  const [discuss, setDiscuss] = useState<string[]>([]);
  const [showDiscuss, setShowDiscuss] = useState(false);
  const [sending, setSending] = useState(false);
  const { fold, connected } = useCompanionStream(sessionId);
  const memory = useMemorySuggestions(data?.memory === true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const errorText = useCallback(
    (code: string | null | undefined) => {
      if (!code) return t('study.errors.generic');
      const key = `study.companion.errors.${code}`;
      const translated = t(key);
      return translated !== key ? translated : t('study.errors.generic');
    },
    [t],
  );

  useEffect(() => {
    let cancelled = false;
    void loadStudyPage(async () => {
      const capabilities = await fetchStudyCapabilities();
      if (!capabilities.companionChat)
        throw Object.assign(new Error('unavailable'), { status: 404 });
      const [classmate, all, spaces, chats, courses] = await Promise.all([
        classmateApi.get(classmateId),
        classmateApi.list('active'),
        studyApi.listSpaces(),
        companionApi.list(classmateId),
        origin?.stageId ? studyApi.listCourses().catch(() => []) : Promise.resolve([]),
      ]);
      const wrongItem = origin?.wrongItemId
        ? await wrongbookApi.get(origin.wrongItemId).catch(() => null)
        : null;
      const originSpaces = wrongItem
        ? [wrongItem.spaceId]
        : origin?.stageId
          ? (courses.find((course) => course.stageId === origin.stageId)?.spaceIds ?? [])
          : [];
      return {
        classmate,
        others: all.filter((item) => item.id !== classmateId),
        spaces: spaces.filter((space) => space.status === 'active'),
        chats,
        originSpaces,
        memory: capabilities.memory,
        explanations: capabilities.explanations,
        wrongItem,
      };
    }).then((result) => {
      if (cancelled) return;
      if (result.state === 'ready') {
        setData(result.data);
        setSpaceId((current) => {
          if (current) return current;
          const candidates = result.data.originSpaces.length
            ? result.data.originSpaces
            : result.data.spaces.map((space) => space.id);
          return candidates.length === 1 ? candidates[0]! : '';
        });
      }
      setState(result.state);
    });
    return () => {
      cancelled = true;
    };
  }, [classmateId, origin, loadKey]);

  // The chat header re-reads the classmate's current template, space and
  // authorised materials whenever a turn starts (its server-resolved turn
  // record arrives) or finishes — also when a reconnect delivers a whole turn
  // at once and the status ends where it began.
  useEffect(() => {
    if (!sessionId) {
      setHeader(null);
      return;
    }
    let cancelled = false;
    companionApi
      .header(sessionId)
      .then((value) => !cancelled && setHeader(value))
      .catch((error) => {
        if (!cancelled) toast.error(errorText(error instanceof StudyApiError ? error.code : null));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, fold.status, fold.turn, fold.answered, errorText]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [fold.nodes.length]);

  const settings = useSettingsStore();
  const classmate = header?.classmate ?? data?.classmate ?? null;
  const voiceUnavailable = classmate?.voice
    ? !roleVoiceBinding(
        [classmate.voice],
        settings.ttsSelection,
        settings.platformDefaults,
        settings.ttsProvidersConfig,
      )
    : false;

  if (state !== 'ready' || !data || !classmate) {
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

  const running = fold.status === 'running' || fold.status === 'queued' || sending;
  const archived = classmate.status !== 'active';
  const spaceArchived = header?.space.status === 'archived';
  const closed = archived || spaceArchived;
  const activeSpaceId = header?.chat.spaceId ?? spaceId;
  const spaceName =
    header?.space.name ?? data.spaces.find((space) => space.id === activeSpaceId)?.name ?? '';
  const lastFailure = [...fold.nodes]
    .reverse()
    .find((node): node is Extract<CompanionNode, { kind: 'status' }> => node.kind === 'status');
  const failureCode =
    fold.status === 'failed' && lastFailure?.status === 'failed'
      ? companionErrorCode(lastFailure.error)
      : null;
  const turnModel = fold.turn?.model;
  const policy = classmate.modelPolicy;

  async function send() {
    const text = draft.trim();
    if (!text || running || closed) return;
    if (!sessionId && !spaceId) {
      toast.error(t('study.companion.pickSpace'));
      return;
    }
    setSending(true);
    try {
      if (sessionId) {
        await companionApi.post(sessionId, { text, discuss });
        memory.consider(text, sessionId, activeSpaceId || null);
      } else {
        const opened = await companionApi.open(classmateId, {
          spaceId,
          question: text,
          discuss,
          origin,
        });
        memory.consider(text, opened.sessionId, spaceId || null);
        router.replace(
          `/study/classmates/${encodeURIComponent(classmateId)}/chat?session=${encodeURIComponent(opened.sessionId)}`,
        );
        setLoadKey((key) => key + 1);
      }
      setDraft('');
      setDiscuss([]);
      setShowDiscuss(false);
    } catch (error) {
      toast.error(errorText(error instanceof StudyApiError ? error.code : null));
    } finally {
      setSending(false);
    }
  }

  async function cancel() {
    if (!sessionId) return;
    const ok = await companionApi.cancel(sessionId);
    if (!ok) toast.message(t('study.companion.cancelNotNeeded'));
  }

  const renderCitation = (ref: string, own: Record<string, CompanionExcerpt>) => {
    const excerpt = own[ref] ?? fold.excerpts[ref];
    const allowed = excerpt && header?.materials.some((m) => m.id === excerpt.materialId);
    if (!excerpt) {
      return (
        <span className="mx-0.5 rounded bg-muted px-1 text-[11px] text-muted-foreground">
          {ref}
        </span>
      );
    }
    return allowed ? (
      <Link
        href={excerptReaderHref(excerpt)}
        title={`${excerpt.title}${excerpt.page ? ` · p.${excerpt.page}` : ''}`}
        className="mx-0.5 rounded bg-primary/10 px-1 text-[11px] font-medium text-primary no-underline hover:underline"
        data-testid="companion-citation"
      >
        {ref}
      </Link>
    ) : (
      <span
        title={t('study.companion.citationWithdrawn')}
        className="mx-0.5 rounded bg-muted px-1 text-[11px] text-muted-foreground line-through"
        data-testid="companion-citation-withdrawn"
      >
        {ref}
      </span>
    );
  };

  const renderAnswer = (text: string, own: Record<string, CompanionExcerpt>, streaming = false) => (
    <CompanionAnswer
      text={text}
      streaming={streaming}
      renderCitation={(ref) => renderCitation(ref, own)}
    />
  );

  const renderNode = (node: CompanionNode) => {
    switch (node.kind) {
      case 'user':
        return (
          <div key={node.key} className="flex justify-end" data-testid="companion-user">
            <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2.5 text-sm leading-6 whitespace-pre-wrap text-primary-foreground">
              {node.text}
              {node.discuss.length ? (
                <div className="mt-1 text-[11px] opacity-80">
                  {t('study.companion.discussWith', {
                    names: node.discuss
                      .map((id) => data.others.find((other) => other.id === id)?.name ?? id)
                      .join('、'),
                  })}
                </div>
              ) : null}
            </div>
          </div>
        );
      case 'assistant':
        if (node.narration) {
          return (
            <p
              key={node.key}
              className="pl-11 text-xs leading-5 whitespace-pre-wrap text-muted-foreground"
              data-testid="companion-narration"
            >
              {node.text}
            </p>
          );
        }
        return (
          <div key={node.key} className="flex gap-3" data-testid="companion-answer">
            <Avatar
              src={node.turn?.avatar ?? classmate.avatar}
              color={node.turn?.color ?? classmate.color}
              size={32}
            />
            <div className="min-w-0 max-w-[85%]">
              <div className="mb-1 text-xs text-muted-foreground">
                {node.turn?.name ?? classmate.name}
                {node.turn ? ` · v${node.turn.revision}` : ''}
              </div>
              <div className="rounded-2xl bg-muted/60 px-4 py-2.5 text-sm leading-6 text-foreground">
                {renderAnswer(node.text, node.excerpts, node.streaming)}
                {node.streaming ? <Loader2 className="ml-1 inline size-3 animate-spin" /> : null}
              </div>
            </div>
          </div>
        );
      case 'invite':
        return (
          <div key={node.key} className="flex gap-3 pl-6" data-testid="companion-invite">
            <Avatar src={node.details.avatar} color={node.details.color} size={28} />
            <div className="min-w-0 max-w-[80%]">
              <div className="mb-1 text-xs text-muted-foreground">
                {node.details.name} · {t('study.companion.invited')}
              </div>
              <div className="rounded-2xl border border-border px-4 py-2 text-sm leading-6">
                {node.details.error ?? renderAnswer(node.details.reply, {})}
              </div>
            </div>
          </div>
        );
      case 'tool':
        return (
          <div
            key={node.key}
            className="flex items-center gap-2 pl-11 text-xs text-muted-foreground"
            data-testid="companion-tool"
          >
            {node.state === 'running' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : node.toolName === 'search_materials' ? (
              <Search className="size-3" />
            ) : (
              <BookOpen className="size-3" />
            )}
            {t(`study.companion.tool.${node.toolName}`, { query: node.query, count: node.found })}
          </div>
        );
      case 'marker':
        return (
          <div
            key={node.key}
            className="my-1 text-center text-xs text-muted-foreground"
            data-testid={`companion-marker-${node.marker}`}
          >
            <span className="rounded-full bg-muted px-3 py-1">
              {node.marker === 'persona-updated'
                ? t('study.companion.personaUpdated', { from: node.from, to: node.to })
                : node.marker === 'model-changed'
                  ? t('study.companion.modelChanged', { label: node.label })
                  : t('study.companion.materialsWithheld', { count: node.count })}
            </span>
          </div>
        );
      case 'status':
        return (
          <div
            key={node.key}
            className="my-1 text-center text-xs"
            data-testid={`companion-status-${node.status}`}
          >
            <span
              className={`rounded-full px-3 py-1 ${node.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}
            >
              {node.status === 'failed'
                ? errorText(companionErrorCode(node.error))
                : node.status === 'cancelled'
                  ? t('study.companion.cancelled')
                  : t('study.companion.interrupted')}
            </span>
          </div>
        );
    }
  };

  return (
    <StudyShell>
      <Link
        href="/study/classmates"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t('study.companion.back')}
      </Link>
      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="space-y-2" data-testid="companion-chats">
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => router.push(`/study/classmates/${encodeURIComponent(classmateId)}/chat`)}
          >
            <MessageSquarePlus className="mr-1.5 size-4" />
            {t('study.companion.newChat')}
          </Button>
          <ul className="space-y-1">
            {data.chats.map((chat) => (
              <li key={chat.sessionId}>
                <Link
                  href={`/study/classmates/${encodeURIComponent(classmateId)}/chat?session=${encodeURIComponent(chat.sessionId)}`}
                  className={`block rounded-lg px-3 py-2 text-sm hover:bg-muted ${chat.sessionId === sessionId ? 'bg-muted font-medium' : ''}`}
                >
                  <div className="truncate">{chat.title}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {data.spaces.find((space) => space.id === chat.spaceId)?.name ?? ''}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </aside>

        <section className="flex min-h-[70vh] flex-col rounded-2xl border border-border bg-card">
          <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4">
            <Avatar src={classmate.avatar} color={classmate.color} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-lg font-semibold">{classmate.name}</h1>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  {t(`study.classmates.role.${classmate.role}`)} · v{classmate.revision}
                </span>
                {spaceName ? (
                  <span
                    className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
                    data-testid="companion-space"
                  >
                    {spaceName}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-xs text-muted-foreground" data-testid="companion-model">
                {policy.mode === 'custom'
                  ? t('study.companion.modelCustom', {
                      label:
                        turnModel?.mode === 'custom'
                          ? turnModel.label
                          : t('study.companion.modelCustomPending'),
                    })
                  : t('study.companion.modelInherit', {
                      label: turnModel?.label ?? t('study.companion.modelCurrent'),
                    })}
                {' · '}
                {voiceUnavailable
                  ? t('study.companion.voiceUnavailable')
                  : t('study.companion.noAutoVoice')}
              </p>
              {header ? (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="companion-materials">
                  {header.materials.length
                    ? t('study.companion.materials', {
                        names: header.materials.map((m) => `《${m.title}》`).join('、'),
                      })
                    : t('study.companion.noMaterials')}
                </p>
              ) : null}
              {data.memory ? <MemoryTurnNote info={fold.turn?.memory} /> : null}
            </div>
            <span
              className={`text-[11px] ${sessionId && !connected ? 'text-review-ink' : 'text-muted-foreground'}`}
              data-testid="companion-connection"
            >
              {sessionId
                ? connected
                  ? t('study.companion.connected')
                  : t('study.companion.reconnecting')
                : ''}
            </span>
          </header>

          {closed ? (
            <div
              className="flex items-center gap-2 border-b border-border bg-review-soft px-5 py-2 text-xs text-review-ink"
              data-testid="companion-closed"
            >
              <AlertTriangle className="size-3.5" />
              {archived
                ? t('study.companion.classmateArchived')
                : t('study.companion.spaceArchived')}
            </div>
          ) : null}
          {failureCode === 'STUDY_CLASSMATE_MODEL_UNAVAILABLE' ? (
            <div
              className="border-b border-border bg-destructive/5 px-5 py-2 text-xs text-destructive"
              data-testid="companion-model-unavailable"
            >
              {errorText(failureCode)}{' '}
              <Link href="/study/classmates" className="underline">
                {t('study.companion.openSettings')}
              </Link>
            </div>
          ) : null}

          <div
            className="flex-1 space-y-4 overflow-y-auto px-5 py-5"
            data-testid="companion-messages"
          >
            {!sessionId ? (
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>{t('study.companion.intro', { name: classmate.name })}</p>
                {origin?.wrongItemId ? (
                  <p
                    className="rounded-lg bg-muted/60 px-3 py-2 text-xs"
                    data-testid="companion-origin"
                  >
                    {data.wrongItem ? (
                      <>
                        {t('study.companion.fromWrongItem')}
                        <span className="mt-1 line-clamp-3 block text-foreground">
                          <QuizMathText
                            text={data.wrongItem.question.stem}
                            trustDelimiters={data.wrongItem.sourceType === 'exam_attempt'}
                          />
                        </span>
                      </>
                    ) : (
                      t('study.companion.wrongItemGone')
                    )}
                  </p>
                ) : origin ? (
                  <p
                    className="rounded-lg bg-muted/60 px-3 py-2 text-xs"
                    data-testid="companion-origin"
                  >
                    {t('study.companion.fromClassroom')}
                    {origin.excerpt ? `：“${origin.excerpt}”` : ''}
                  </p>
                ) : null}
                <label className={cn('block text-xs', data.wrongItem && 'hidden')}>
                  {t('study.companion.space')}
                  <select
                    className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                    value={spaceId}
                    onChange={(event) => setSpaceId(event.target.value)}
                    data-testid="companion-space-select"
                  >
                    <option value="">{t('study.companion.pickSpace')}</option>
                    {data.spaces.map((space) => (
                      <option key={space.id} value={space.id}>
                        {space.name}
                        {data.originSpaces.includes(space.id)
                          ? ` · ${t('study.companion.courseSpace')}`
                          : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}
            {header?.chat.origin?.wrongItem ? (
              <p
                className="text-center text-[11px] text-muted-foreground"
                data-testid="companion-wrong-origin"
              >
                {t('study.companion.openedFromWrongItem', {
                  where: header.chat.origin.wrongItem.where,
                })}{' '}
                <Link
                  href={`/study/${encodeURIComponent(header.chat.spaceId)}/wrongbook`}
                  className="text-primary hover:underline"
                >
                  {t('study.wrongbook.open')}
                </Link>
                {data?.explanations ? (
                  <>
                    {' · '}
                    <Link
                      href={itemExplanationsHref(
                        header.chat.spaceId,
                        header.chat.origin.wrongItem.itemId,
                      )}
                      className="text-primary hover:underline"
                      data-testid="companion-explain-link"
                    >
                      {t('study.explain.fromChat')}
                    </Link>
                  </>
                ) : null}
              </p>
            ) : null}
            {header?.originCourse && header.chat.origin && !header.chat.origin.wrongItem ? (
              <p className="text-center text-[11px] text-muted-foreground">
                {t('study.companion.openedFrom', { course: header.originCourse.title })}
              </p>
            ) : null}
            {fold.nodes.map(renderNode)}
            <div ref={bottomRef} />
          </div>

          <footer className="border-t border-border px-5 py-3">
            {memory.offer ? (
              <MemorySuggestionBar
                offer={memory.offer}
                spaceName={spaceName}
                onAccept={memory.accept}
                onDecline={() => void memory.decline()}
              />
            ) : null}
            {showDiscuss ? (
              <div
                className="mb-2 rounded-lg bg-muted/50 px-3 py-2 text-xs"
                data-testid="companion-discuss"
              >
                <p className="mb-1.5 text-muted-foreground">{t('study.companion.discussHint')}</p>
                <div className="flex flex-wrap gap-2">
                  {data.others.length === 0 ? <span>{t('study.companion.noOthers')}</span> : null}
                  {data.others.map((other) => {
                    const checked = discuss.includes(other.id);
                    return (
                      <label key={other.id} className="inline-flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={
                            !checked && discuss.length >= COMPANION_LIMITS.discussionInvites
                          }
                          onChange={() =>
                            setDiscuss((list) =>
                              checked ? list.filter((id) => id !== other.id) : [...list, other.id],
                            )
                          }
                        />
                        {other.name}
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <Button
                variant={discuss.length ? 'secondary' : 'ghost'}
                size="icon"
                aria-label={t('study.companion.discuss')}
                title={t('study.companion.discuss')}
                onClick={() => setShowDiscuss((value) => !value)}
                disabled={closed}
              >
                <Users className="size-4" />
              </Button>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                maxLength={COMPANION_LIMITS.question}
                disabled={closed}
                placeholder={
                  closed
                    ? t('study.companion.closedPlaceholder')
                    : t('study.companion.placeholder', { name: classmate.name })
                }
                className="min-h-[44px] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm"
                data-testid="companion-input"
              />
              {running && sessionId ? (
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={t('study.companion.stop')}
                  onClick={() => void cancel()}
                  data-testid="companion-stop"
                >
                  <Square className="size-4" />
                </Button>
              ) : null}
              <Button
                onClick={() => void send()}
                disabled={!draft.trim() || running || closed}
                aria-label={t('study.companion.send')}
                data-testid="companion-send"
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
              </Button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground" data-testid="companion-usage">
              {fold.status === 'queued'
                ? t('study.companion.queued')
                : fold.status === 'running'
                  ? t('study.companion.thinking', { name: classmate.name })
                  : t('study.companion.usage', { answers: fold.answered, tools: fold.toolCalls })}
            </p>
          </footer>
        </section>
      </div>
    </StudyShell>
  );
}
