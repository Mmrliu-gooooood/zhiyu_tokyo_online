import { AsyncLocalStorage } from 'node:async_hooks';

import {
  POLLED_TASK_PERSISTENCE_GLOBAL_KEY,
  type PolledTaskPersistence,
} from '@/lib/media/polled-task-context';

const state = globalThis as typeof globalThis & {
  [POLLED_TASK_PERSISTENCE_GLOBAL_KEY]?: AsyncLocalStorage<PolledTaskPersistence>;
};

const persistenceContext = (state[POLLED_TASK_PERSISTENCE_GLOBAL_KEY] ??=
  new AsyncLocalStorage<PolledTaskPersistence>());

export function withPolledTaskPersistence<T>(
  persistence: PolledTaskPersistence,
  work: () => Promise<T>,
): Promise<T> {
  return persistenceContext.run(persistence, work);
}
