export type GenerationCanonicalPhase =
  | 'idle'
  | 'outline-streaming'
  | 'outline-review'
  | 'agent-generation'
  | 'scene-generation'
  | 'media-actions'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type GenerationRunStartPhase = Exclude<
  GenerationCanonicalPhase,
  'idle' | 'outline-review' | 'completed' | 'failed' | 'cancelled'
>;

export type GenerationRun = {
  epoch: number;
  signal: AbortSignal;
};

type GenerationSessionRuntimeOptions = {
  onPhase?: (phase: GenerationCanonicalPhase) => void;
};

const HAPPY_PATH_TRANSITIONS: Readonly<
  Record<GenerationCanonicalPhase, ReadonlySet<GenerationCanonicalPhase>>
> = {
  idle: new Set(),
  'outline-streaming': new Set(['outline-review', 'agent-generation']),
  'outline-review': new Set(['agent-generation']),
  'agent-generation': new Set(['scene-generation']),
  'scene-generation': new Set(['media-actions']),
  'media-actions': new Set(['completed']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const TERMINAL_PHASES = new Set<GenerationCanonicalPhase>(['completed', 'failed', 'cancelled']);

/**
 * Mount-scoped authority for generation epochs and canonical transitions.
 * It deliberately owns no application data: callers may commit data only
 * through the epoch fence exposed here.
 */
export class GenerationSessionRuntime {
  private epoch = 0;
  private controller: AbortController | null = null;
  private currentPhase: GenerationCanonicalPhase = 'idle';

  constructor(private readonly options: GenerationSessionRuntimeOptions = {}) {}

  get phase(): GenerationCanonicalPhase {
    return this.currentPhase;
  }

  start(initialPhase: GenerationRunStartPhase = 'outline-streaming'): GenerationRun {
    this.invalidate();
    this.controller = new AbortController();
    this.setPhase(initialPhase);
    return { epoch: this.epoch, signal: this.controller.signal };
  }

  restart(initialPhase: GenerationRunStartPhase = 'outline-streaming'): GenerationRun {
    return this.start(initialPhase);
  }

  transition(epoch: number, next: GenerationCanonicalPhase): boolean {
    if (!this.isCurrent(epoch)) return false;
    const allowed =
      next === 'failed' || next === 'cancelled'
        ? !TERMINAL_PHASES.has(this.currentPhase)
        : HAPPY_PATH_TRANSITIONS[this.currentPhase].has(next);
    if (!allowed) return false;
    this.setPhase(next);
    if (TERMINAL_PHASES.has(next)) this.controller = null;
    return true;
  }

  commit(epoch: number, effect: () => void): boolean {
    if (!this.isCurrent(epoch) || TERMINAL_PHASES.has(this.currentPhase)) return false;
    effect();
    return true;
  }

  isCurrent(epoch: number): boolean {
    return (
      epoch === this.epoch &&
      this.controller !== null &&
      !this.controller.signal.aborted &&
      !TERMINAL_PHASES.has(this.currentPhase)
    );
  }

  cancel(): void {
    if (!this.controller) return;
    this.controller.abort();
    if (!TERMINAL_PHASES.has(this.currentPhase)) this.setPhase('cancelled');
    this.controller = null;
    this.epoch += 1;
  }

  stop(): void {
    this.cancel();
  }

  private invalidate(): void {
    this.controller?.abort();
    this.controller = null;
    this.epoch += 1;
  }

  private setPhase(phase: GenerationCanonicalPhase): void {
    this.currentPhase = phase;
    this.options.onPhase?.(phase);
  }
}
