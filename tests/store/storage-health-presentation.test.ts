import { describe, expect, it } from 'vitest';
import { projectPersistHealthPresentation } from '@/components/storage-health-presentation';

describe('projectPersistHealthPresentation', () => {
  it('projects every truthful persistence-health event into a semantic ZHIYU state', () => {
    expect(projectPersistHealthPresentation('unavailable')).toEqual({
      state: 'degraded',
      messageKey: 'settings.persistUnavailable',
    });
    expect(projectPersistHealthPresentation('changes-lost')).toEqual({
      state: 'error',
      messageKey: 'settings.persistChangesLost',
    });
    expect(projectPersistHealthPresentation('recovered')).toEqual({
      state: 'recovered',
      messageKey: 'settings.persistRecovered',
    });
  });
});
