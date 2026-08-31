import type { PersistHealthStatus } from '@/lib/store/persist-health';

export type PersistHealthVisualState = 'degraded' | 'error' | 'recovered';

export function projectPersistHealthPresentation(status: PersistHealthStatus): {
  readonly state: PersistHealthVisualState;
  readonly messageKey:
    | 'settings.persistUnavailable'
    | 'settings.persistChangesLost'
    | 'settings.persistRecovered';
} {
  if (status === 'changes-lost') {
    return { state: 'error', messageKey: 'settings.persistChangesLost' };
  }
  if (status === 'recovered') {
    return { state: 'recovered', messageKey: 'settings.persistRecovered' };
  }
  return { state: 'degraded', messageKey: 'settings.persistUnavailable' };
}
