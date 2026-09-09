export interface PolledTaskPersistence {
  resumeTaskId?: string;
  persistTaskId(taskId: string): Promise<void>;
}

export const POLLED_TASK_PERSISTENCE_GLOBAL_KEY = '__openmaicPolledTaskPersistence' as const;

interface PolledTaskPersistenceReader {
  getStore(): PolledTaskPersistence | undefined;
}

export function readPolledTaskPersistence(): PolledTaskPersistence | undefined {
  const state = globalThis as typeof globalThis & {
    [POLLED_TASK_PERSISTENCE_GLOBAL_KEY]?: PolledTaskPersistenceReader;
  };
  return state[POLLED_TASK_PERSISTENCE_GLOBAL_KEY]?.getStore();
}
