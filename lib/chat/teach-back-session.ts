import type { StatelessEvent } from '@/lib/types/chat';
import {
  assertCanFinish,
  assertCanRetryEvaluation,
  assertCanSubmitExplanation,
  bindTeachBackSource,
  canInitiateModelCall,
  nextTurnIndex,
  type TeachBackProjectedActivity,
} from '@/lib/learning/teach-back/activity';
import {
  TEACH_BACK_LIMITS,
  type TeachBackApiOutput,
  type TeachBackErrorCode,
  type TeachBackExplanation,
  type TeachBackFinishReason,
  type TeachBackPeer,
  type TeachBackSource,
  type TeachBackSuspendReason,
  teachBackClosingSpeech,
  type TeachBackTurnResult,
  type TeachBackUiTransient,
} from '@/lib/learning/teach-back/contracts';
import {
  appendTeachBackEvent,
  readTeachBackActivity,
  type TeachBackAppendResult,
} from '@/lib/learning/teach-back/runtime';

export interface TeachBackProducer {
  activityId: string;
  sessionId: string;
  stageId: string;
  sceneId: string;
  sourceRevision: string;
  viewEpoch: number;
}

export interface TeachBackView {
  activity: TeachBackProjectedActivity | null;
  ui: TeachBackUiTransient;
  errorCode?: TeachBackErrorCode;
  errorDetail?: string;
  confirmReplaceQa?: boolean;
  canResumeLecture?: boolean;
}

export interface TeachBackModelConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  providerType?: string;
  modelSource?: 'platform' | 'user' | 'legacy-managed';
  platformDefaultId?: string;
  api?: string;
  endpointProfile?: string;
  endpointParams?: Record<string, string>;
  credentialId?: string;
  thinkingConfig?: unknown;
}

export interface TeachBackHost {
  isCurrent: (producer: TeachBackProducer) => boolean;
  enterLiveConversation: () => void;
  retireRequestsAndAudio: () => Promise<void>;
  presentEvents: (events: StatelessEvent[], signal: AbortSignal) => Promise<void>;
  fetchTeachBack: (body: unknown, signal: AbortSignal) => Promise<Response>;
  getModelConfig: () => TeachBackModelConfig;
  getLocale: () => string;
  now: () => string;
  mintId: () => string;
  onView: (view: TeachBackView) => void;
  readCurrentSource?: () => Promise<
    { ok: true; source: TeachBackSource } | { ok: false; code: TeachBackErrorCode }
  >;
}

export function buildTeachBackSpeechEvents(input: {
  messageId: string;
  peer: TeachBackPeer;
  text: string;
  cue?: { prompt: string };
}): StatelessEvent[] {
  const events: StatelessEvent[] = [
    {
      type: 'agent_start',
      data: {
        messageId: input.messageId,
        agentId: input.peer.id,
        agentName: input.peer.name,
        agentAvatar: input.peer.avatar,
        agentColor: input.peer.color,
      },
    },
    { type: 'text_delta', data: { messageId: input.messageId, content: input.text } },
    { type: 'agent_end', data: { messageId: input.messageId, agentId: input.peer.id } },
  ];
  if (input.cue) {
    events.push({
      type: 'cue_user',
      data: { fromAgentId: input.peer.id, prompt: input.cue.prompt },
    });
  }
  events.push({
    type: 'done',
    data: {
      totalActions: 0,
      totalAgents: 1,
      agentHadContent: true,
      cueUserReceived: Boolean(input.cue),
      sessionClosed: false,
    },
  });
  return events;
}

/**
 * A completed teach-back round stays closed until the learner explicitly asks
 * the companion to ask again. Acknowledgements and learner-authored questions
 * must not silently open a fresh three-explanation round.
 */
export function isTeachBackFollowUpRequest(content: string): boolean {
  const normalized = content
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[。！？!?.,，；;：:]+$/u, '')
    .replace(/\s+/g, ' ');
  if (!normalized) return false;

  const compact = normalized.replace(/\s+/g, '');

  return (
    /^(?:请|請)?(?:继续提问|繼續提問|继续问我|繼續問我|接着问我|接著問我|再问我(?:一个问题)?|再問我(?:一個問題)?|继续出题|繼續出題|接着出题|接著出題|再出题|再出題|继续考我|繼續考我|接着考我|接著考我|再考我|再来一轮|再來一輪|下一轮|下一輪|新一轮|新一輪)$/u.test(
      compact,
    ) ||
    /^(?:我(?:还)?想让)?(?:ai|学伴|你)(?:继续|接着|再)?(?:提问|问我|出题|考我)$/iu.test(compact) ||
    /^(?:please )?(?:ask|quiz) me (?:again|another(?: question)?|one more(?: question)?)$/iu.test(
      normalized,
    ) ||
    /^(?:please )?(?:continue|keep) (?:asking|quizzing) me$/iu.test(normalized) ||
    /^(?:another|next|new) round$/iu.test(normalized) ||
    /^(?:もう一度質問して|다시질문해줘|pose-moiuneautrequestion|stellmirnocheinefrage|hazmeotrapregunta|façaoutrapergunta|задаймнеещёодинвопрос|hỏitôithêmmộtcâu|اسألنيسؤالا(?:ً)?آخر)$/iu.test(
      compact,
    )
  );
}

function mapHttpError(code: string | undefined): TeachBackErrorCode {
  if (
    code === 'feature_disabled' ||
    code === 'invalid_request' ||
    code === 'insufficient_source' ||
    code === 'quiz_in_progress' ||
    code === 'model_unavailable' ||
    code === 'timeout' ||
    code === 'invalid_output' ||
    code === 'source_stale' ||
    code === 'storage_conflict' ||
    code === 'budget_exhausted' ||
    code === 'save_failed' ||
    code === 'no_peer'
  ) {
    return code;
  }
  return 'model_unavailable';
}

export class TeachBackSession {
  private producer: TeachBackProducer | undefined;
  private view: TeachBackView = { activity: null, ui: 'idle' };
  private pendingPrepare: TeachBackApiOutput | undefined;
  private pendingPrepareSource: TeachBackSource | undefined;
  private pendingResult: TeachBackTurnResult | undefined;
  private abort: AbortController | undefined;

  constructor(private readonly host: TeachBackHost) {}

  getView(): TeachBackView {
    return this.view;
  }

  getProducer(): TeachBackProducer | undefined {
    return this.producer;
  }

  abortActiveRequest(): void {
    this.abort?.abort();
    this.abort = undefined;
  }

  surfaceError(code: TeachBackErrorCode, detail?: string): void {
    this.setView({
      ...this.view,
      ui: this.view.ui === 'preparing' || this.view.ui === 'submitting' ? 'idle' : this.view.ui,
      errorCode: code,
      errorDetail: detail,
    });
  }

  attach(producer: TeachBackProducer, activity: TeachBackProjectedActivity): void {
    this.abortActiveRequest();
    this.producer = producer;
    const paused =
      activity.logicalPhase !== 'finished' && activity.logicalPhase !== 'summary_ready';
    this.setView({
      activity,
      ui: paused ? 'paused' : 'idle',
      errorCode: undefined,
      errorDetail: undefined,
    });
  }

  private setView(patch: Partial<TeachBackView>): void {
    this.view = { ...this.view, ...patch };
    this.host.onView(this.view);
  }

  private currentOrThrow(producer: TeachBackProducer): void {
    if (!this.host.isCurrent(producer)) {
      throw new DOMException('The teach-back request is no longer current.', 'AbortError');
    }
  }

  private async append(
    activityId: string,
    stageId: string,
    commandId: string,
    event: Parameters<typeof appendTeachBackEvent>[0]['event'],
    expectedLastSeq: number | null,
    finishSession = false,
  ): Promise<TeachBackAppendResult> {
    return appendTeachBackEvent({
      activityId,
      commandId,
      event,
      stageId,
      expectedLastSeq,
      finishSession,
    });
  }

  async start(input: {
    activityId: string;
    sessionId: string;
    source: TeachBackSource;
    topic: string;
    peer: TeachBackPeer;
    viewEpoch: number;
    replaceOpenQa: boolean;
  }): Promise<void> {
    const producer: TeachBackProducer = {
      activityId: input.activityId,
      sessionId: input.sessionId,
      stageId: input.source.stageId,
      sceneId: input.source.sceneId,
      sourceRevision: input.source.sourceRevision,
      viewEpoch: input.viewEpoch,
    };
    this.producer = producer;
    this.abortActiveRequest();
    await this.host.retireRequestsAndAudio();
    this.currentOrThrow(producer);
    this.host.enterLiveConversation();
    this.setView({ ui: 'preparing', errorCode: undefined, confirmReplaceQa: input.replaceOpenQa });

    const { activity } = await readTeachBackActivity(input.activityId);
    if (!canInitiateModelCall(activity)) {
      this.setView({ ui: 'idle', errorCode: 'budget_exhausted', activity });
      return;
    }
    const requestId = this.host.mintId();
    const registered = await this.append(
      input.activityId,
      input.source.stageId,
      `prepare:${requestId}`,
      {
        kind: 'prepare_requested',
        createdAt: this.host.now(),
        requestId,
        source: input.source,
        topic: input.topic,
        peer: input.peer,
      },
      activity.lastSeq < 0 ? null : activity.lastSeq,
    );
    if (registered.status !== 'applied') {
      this.setView({
        ui: 'idle',
        errorCode: registered.status === 'replayed' ? 'storage_conflict' : 'storage_conflict',
        activity: registered.activity,
      });
      return;
    }

    const controller = new AbortController();
    this.abort = controller;
    try {
      const output = await this.request(
        {
          operation: 'prepare',
          activityId: input.activityId,
          requestId,
          source: input.source,
          topic: input.topic,
          peer: input.peer,
        },
        controller.signal,
      );
      this.currentOrThrow(producer);
      if (output.operation !== 'prepare') throw new Error('Unexpected teach-back payload');
      this.pendingPrepare = output;
      this.pendingPrepareSource = input.source;
      this.setView({ ui: 'saving', activity: registered.activity });
      const saved = await this.append(
        input.activityId,
        input.source.stageId,
        `prepared:${requestId}`,
        {
          kind: 'activity_prepared',
          createdAt: this.host.now(),
          plan: output.plan,
          source: input.source,
        },
        registered.seq,
      );
      if (saved.status !== 'applied' && saved.status !== 'replayed') {
        this.setView({ ui: 'idle', errorCode: 'save_failed', activity: saved.activity });
        return;
      }
      this.pendingPrepare = undefined;
      this.pendingPrepareSource = undefined;
      this.currentOrThrow(producer);
      await this.host.presentEvents(
        buildTeachBackSpeechEvents({
          messageId: `teach-back-${input.activityId}-open`,
          peer: output.plan.peer,
          text: output.plan.openingQuestion.text,
          cue: { prompt: output.plan.openingQuestion.text },
        }),
        controller.signal,
      );
      this.setView({ activity: saved.activity, ui: 'idle', errorCode: undefined });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.setView({
        ui: 'idle',
        errorCode: error instanceof Error ? mapHttpError(error.message) : 'model_unavailable',
        activity: registered.activity,
      });
    } finally {
      if (this.abort === controller) this.abort = undefined;
    }
  }

  async submitExplanation(input: { text: string; producer: TeachBackProducer }): Promise<void> {
    const trimmed = input.text.trim();
    if (!trimmed || trimmed.length > TEACH_BACK_LIMITS.explanationCharacters) {
      this.setView({ ...this.view, errorCode: 'invalid_request' });
      return;
    }
    this.currentOrThrow(input.producer);
    const { activity } = await readTeachBackActivity(input.producer.activityId);
    if (!(await this.assertCurrentSource(activity))) return;
    assertCanSubmitExplanation(activity);
    if (!activity.plan || !activity.currentQuestion) {
      throw new Error('Teach-back is missing a current question');
    }
    const explanation: TeachBackExplanation = {
      turnId: this.host.mintId(),
      turnIndex: nextTurnIndex(activity.explanations),
      text: trimmed,
      submittedAt: this.host.now(),
      questionId: activity.currentQuestion.questionId,
    };
    this.setView({ ui: 'submitting', activity, errorCode: undefined });
    const saved = await this.append(
      input.producer.activityId,
      input.producer.stageId,
      `explain:${explanation.turnId}`,
      {
        kind: 'explanation_submitted',
        createdAt: this.host.now(),
        explanation,
      },
      activity.lastSeq < 0 ? null : activity.lastSeq,
    );
    if (saved.status !== 'applied') {
      this.setView({ ui: 'idle', errorCode: 'save_failed', activity: saved.activity });
      return;
    }
    await this.evaluateTurn(input.producer, saved.activity, explanation.turnId, 'submitting');
  }

  async retryEvaluation(producer: TeachBackProducer, turnId: string): Promise<void> {
    this.currentOrThrow(producer);
    const { activity } = await readTeachBackActivity(producer.activityId);
    if (!(await this.assertCurrentSource(activity))) return;
    assertCanRetryEvaluation(activity, turnId);
    if (activity.results.some((result) => result.turnId === turnId) && this.pendingResult) {
      await this.savePendingResult(producer, activity, turnId);
      return;
    }
    await this.evaluateTurn(producer, activity, turnId, 'retrying');
  }

  async retrySave(producer: TeachBackProducer): Promise<void> {
    this.currentOrThrow(producer);
    const { activity } = await readTeachBackActivity(producer.activityId);
    if (this.pendingPrepare && this.pendingPrepare.operation === 'prepare') {
      const source = activity.source ?? this.pendingPrepareSource;
      if (!source) {
        this.setView({ ui: 'idle', errorCode: 'save_failed', activity });
        return;
      }
      this.setView({ ui: 'saving', activity });
      const plan = this.pendingPrepare.plan;
      const saved = await this.append(
        producer.activityId,
        producer.stageId,
        `prepared-retry:${this.host.mintId()}`,
        {
          kind: 'activity_prepared',
          createdAt: this.host.now(),
          plan,
          source,
        },
        activity.lastSeq < 0 ? null : activity.lastSeq,
      );
      if (saved.status === 'conflict') {
        this.setView({ ui: 'idle', errorCode: 'save_failed', activity: saved.activity });
        return;
      }
      this.pendingPrepare = undefined;
      this.pendingPrepareSource = undefined;
      if (saved.activity.plan && saved.activity.currentQuestion) {
        const controller = new AbortController();
        this.abort = controller;
        try {
          await this.host.presentEvents(
            buildTeachBackSpeechEvents({
              messageId: `teach-back-${producer.activityId}-open`,
              peer: saved.activity.plan.peer,
              text: saved.activity.currentQuestion.text,
              cue: { prompt: saved.activity.currentQuestion.text },
            }),
            controller.signal,
          );
        } finally {
          if (this.abort === controller) this.abort = undefined;
        }
      }
      this.setView({ activity: saved.activity, ui: 'idle' });
      return;
    }
    if (this.pendingResult && activity.pendingTurnId) {
      await this.savePendingResult(producer, activity, activity.pendingTurnId);
    }
  }

  async suspend(reason: TeachBackSuspendReason): Promise<void> {
    this.abortActiveRequest();
    const producer = this.producer;
    if (!producer) return;
    const { activity } = await readTeachBackActivity(producer.activityId);
    if (!activity.hasStarted || activity.phase === 'finished') return;
    const saved = await this.append(
      producer.activityId,
      producer.stageId,
      `suspend:${this.host.mintId()}`,
      { kind: 'activity_suspended', createdAt: this.host.now(), reason },
      activity.lastSeq < 0 ? null : activity.lastSeq,
    );
    this.setView({ activity: saved.activity, ui: 'paused' });
  }

  async restore(producer: TeachBackProducer, replaySavedSpeech: boolean): Promise<void> {
    this.producer = producer;
    const { activity } = await readTeachBackActivity(producer.activityId);
    if (activity.hasStarted && !(await this.assertCurrentSource(activity))) return;
    if (!activity.hasStarted) {
      this.setView({ activity, ui: 'idle' });
      return;
    }
    const resumed = await this.append(
      producer.activityId,
      producer.stageId,
      `resume:${this.host.mintId()}`,
      { kind: 'activity_resumed', createdAt: this.host.now() },
      activity.lastSeq < 0 ? null : activity.lastSeq,
    );
    this.setView({ activity: resumed.activity, ui: 'idle', errorCode: undefined });
    if (!replaySavedSpeech || !resumed.activity.plan) return;
    if (resumed.activity.logicalPhase === 'evaluation_pending' && resumed.activity.pendingTurnId) {
      this.setView({
        activity: resumed.activity,
        ui: 'idle',
        errorCode: 'model_unavailable',
        errorDetail: 'evaluation_pending',
      });
      return;
    }
    if (resumed.activity.logicalPhase === 'summary_ready') return;
    const question = resumed.activity.currentQuestion;
    if (!question) return;
    const controller = new AbortController();
    this.abort = controller;
    try {
      await this.host.presentEvents(
        buildTeachBackSpeechEvents({
          messageId: `teach-back-${producer.activityId}-restore-${question.questionId}`,
          peer: resumed.activity.plan.peer,
          text: question.text,
          cue: { prompt: question.text },
        }),
        controller.signal,
      );
    } finally {
      if (this.abort === controller) this.abort = undefined;
    }
  }

  async finish(reason: TeachBackFinishReason): Promise<{ saveFailed: boolean }> {
    this.abortActiveRequest();
    const producer = this.producer;
    if (!producer) return { saveFailed: false };
    const { activity } = await readTeachBackActivity(producer.activityId);
    if (!activity.hasStarted) {
      this.setView({ activity: null, ui: 'idle' });
      this.producer = undefined;
      return { saveFailed: false };
    }
    try {
      assertCanFinish(activity);
      const saved = await this.append(
        producer.activityId,
        producer.stageId,
        `finish:${reason}:${this.host.mintId()}`,
        { kind: 'activity_finished', createdAt: this.host.now(), reason },
        activity.lastSeq < 0 ? null : activity.lastSeq,
        true,
      );
      const saveFailed = saved.status === 'conflict';
      this.setView({
        activity: saved.activity,
        ui: 'idle',
        errorCode: saveFailed ? 'save_failed' : undefined,
      });
      this.producer = undefined;
      return { saveFailed };
    } catch {
      this.producer = undefined;
      this.setView({ activity, ui: 'idle', errorCode: 'save_failed' });
      return { saveFailed: true };
    }
  }

  private async savePendingResult(
    producer: TeachBackProducer,
    activity: TeachBackProjectedActivity,
    turnId: string,
  ): Promise<void> {
    if (!this.pendingResult) return;
    this.setView({ ui: 'saving', activity });
    const saved = await this.append(
      producer.activityId,
      producer.stageId,
      `evaluated:${turnId}`,
      {
        kind: 'turn_evaluated',
        createdAt: this.host.now(),
        result: this.pendingResult,
      },
      activity.lastSeq < 0 ? null : activity.lastSeq,
    );
    if (saved.status === 'conflict') {
      this.setView({ ui: 'idle', errorCode: 'save_failed', activity: saved.activity });
      return;
    }
    const result = this.pendingResult;
    this.pendingResult = undefined;
    this.currentOrThrow(producer);
    await this.presentTurn(producer, saved.activity, result);
  }

  private async evaluateTurn(
    producer: TeachBackProducer,
    activity: TeachBackProjectedActivity,
    turnId: string,
    ui: TeachBackUiTransient,
  ): Promise<void> {
    if (!activity.plan || !activity.source) return;
    if (!canInitiateModelCall(activity)) {
      this.setView({ ui: 'idle', errorCode: 'budget_exhausted', activity });
      return;
    }
    const requestId = this.host.mintId();
    const registered = await this.append(
      producer.activityId,
      producer.stageId,
      `evaluate:${requestId}`,
      {
        kind: 'evaluation_requested',
        createdAt: this.host.now(),
        requestId,
        turnId,
      },
      activity.lastSeq < 0 ? null : activity.lastSeq,
    );
    if (registered.status !== 'applied') {
      this.setView({ ui: 'idle', errorCode: 'storage_conflict', activity: registered.activity });
      return;
    }
    this.setView({ ui, activity: registered.activity });
    const controller = new AbortController();
    this.abort = controller;
    try {
      const output = await this.request(
        {
          operation: 'evaluate',
          activityId: producer.activityId,
          requestId,
          source: activity.source,
          plan: activity.plan,
          explanations: registered.activity.explanations,
          priorResults: registered.activity.results,
          turnId,
          locale: this.host.getLocale(),
        },
        controller.signal,
      );
      this.currentOrThrow(producer);
      if (output.operation !== 'evaluate') throw new Error('Unexpected teach-back payload');
      this.pendingResult = output.result;
      await this.savePendingResult(producer, registered.activity, turnId);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.setView({
        ui: 'idle',
        errorCode: error instanceof Error ? mapHttpError(error.message) : 'model_unavailable',
        activity: registered.activity,
      });
    } finally {
      if (this.abort === controller) this.abort = undefined;
    }
  }

  private async assertCurrentSource(activity: TeachBackProjectedActivity): Promise<boolean> {
    if (!this.host.readCurrentSource || !activity.source) return true;
    const current = await this.host.readCurrentSource();
    if (!current.ok) {
      this.setView({ activity, ui: 'idle', errorCode: current.code });
      return false;
    }
    const code = bindTeachBackSource(activity, current.source);
    if (code) {
      this.setView({ activity, ui: 'idle', errorCode: code });
      return false;
    }
    return true;
  }

  private async presentTurn(
    producer: TeachBackProducer,
    activity: TeachBackProjectedActivity,
    result: TeachBackTurnResult,
  ): Promise<void> {
    if (!activity.plan) return;
    const controller = new AbortController();
    this.abort = controller;
    try {
      if (result.nextQuestion) {
        await this.host.presentEvents(
          buildTeachBackSpeechEvents({
            messageId: `teach-back-${producer.activityId}-${result.turnId}`,
            peer: activity.plan.peer,
            text: result.nextQuestion.text,
            cue: { prompt: result.nextQuestion.text },
          }),
          controller.signal,
        );
      } else {
        const closing = teachBackClosingSpeech(result, activity.plan);
        if (closing) {
          await this.host.presentEvents(
            buildTeachBackSpeechEvents({
              messageId: `teach-back-${producer.activityId}-${result.turnId}`,
              peer: activity.plan.peer,
              text: closing,
            }),
            controller.signal,
          );
        }
      }
      this.setView({ activity, ui: 'idle', errorCode: undefined });
    } finally {
      if (this.abort === controller) this.abort = undefined;
    }
  }

  private async request(learning: unknown, signal: AbortSignal): Promise<TeachBackApiOutput> {
    const timeout = AbortSignal.timeout(TEACH_BACK_LIMITS.clientWaitMs);
    const combined = AbortSignal.any([signal, timeout]);
    const model = this.host.getModelConfig();
    const response = await this.host.fetchTeachBack(
      {
        learning,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        model: model.model,
        providerType: model.providerType,
        modelSource: model.modelSource,
        platformDefaultId: model.platformDefaultId,
        api: model.api,
        endpointProfile: model.endpointProfile,
        endpointParams: model.endpointParams,
        credentialId: model.credentialId,
        thinkingConfig: model.thinkingConfig,
      },
      combined,
    );
    const body = (await response.json().catch(() => null)) as
      | ({ success?: unknown; code?: string; error?: string } & Partial<TeachBackApiOutput>)
      | null;
    if (!response.ok || body?.success !== true) {
      throw new Error(mapHttpError(body?.code));
    }
    if (body.operation === 'prepare' && body.plan) {
      return { operation: 'prepare', plan: body.plan };
    }
    if (body.operation === 'evaluate' && body.result) {
      return { operation: 'evaluate', result: body.result };
    }
    throw new Error('invalid_output');
  }
}

export function shouldRouteToTeachBack(
  requested: string | undefined,
  sessionMode: string | undefined,
): boolean {
  return requested === 'teach_back' || sessionMode === 'teach_back';
}

export function shouldSkipAgentLoopForTeachBack(sessionMode: string | undefined): boolean {
  return sessionMode === 'teach_back';
}
