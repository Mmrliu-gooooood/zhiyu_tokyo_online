interface JobQueue {
  active: boolean;
  heartbeats: Array<() => void>;
  mutations: Array<() => void>;
}

/**
 * Serialize one worker's transactions for the same job before pool checkout.
 * PostgreSQL remains the cross-process fence. Without this queue, concurrent
 * scene/TTS transactions consume all clients waiting for the same job row,
 * leaving heartbeat and unrelated schedulers unable to obtain a connection.
 * Only transaction bodies belong here, never provider or object-store I/O.
 */
export class GenerationTransactionQueue {
  private readonly jobs = new Map<string, JobQueue>();

  run<T>(jobId: string, body: () => Promise<T>, heartbeat = false): Promise<T> {
    let queue = this.jobs.get(jobId);
    if (!queue) {
      queue = { active: false, heartbeats: [], mutations: [] };
      this.jobs.set(jobId, queue);
    }
    const current = queue;
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        current.active = true;
        void (async () => {
          try {
            resolve(await body());
          } catch (error) {
            reject(error);
          } finally {
            current.active = false;
            this.advance(jobId, current);
          }
        })();
      };
      (heartbeat ? current.heartbeats : current.mutations).push(start);
      if (!current.active) this.advance(jobId, current);
    });
  }

  private advance(jobId: string, queue: JobQueue): void {
    const next = queue.heartbeats.shift() ?? queue.mutations.shift();
    if (next) next();
    else this.jobs.delete(jobId);
  }
}
