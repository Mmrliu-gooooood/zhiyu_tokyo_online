import { describe, expect, it } from 'vitest';
import {
  HOSTED_PROJECT_REF,
  HOSTED_SESSION_POOLER_HOST,
  isHostedDbHost,
  hostedRoleFromUsername,
} from '../../scripts/lib/hosted-operator-env';

describe('Hosted operator safety guards', () => {
  it('pins operator commands to the active project', () => {
    expect(isHostedDbHost(`db.${HOSTED_PROJECT_REF}.supabase.co`)).toBe(true);
    expect(isHostedDbHost(HOSTED_SESSION_POOLER_HOST)).toBe(true);
    expect(isHostedDbHost('db.unrelated-project.supabase.co')).toBe(false);
    expect(isHostedDbHost('attacker.example')).toBe(false);
  });
  it('rejects pooled usernames for unrelated projects', () => {
    expect(hostedRoleFromUsername(`zhiyu_app_web.${HOSTED_PROJECT_REF}`)).toBe('zhiyu_app_web');
    expect(hostedRoleFromUsername(`zhiyu_app_worker.${HOSTED_PROJECT_REF}`)).toBe(
      'zhiyu_app_worker',
    );
    expect(hostedRoleFromUsername(`postgres.${HOSTED_PROJECT_REF}`)).toBe('postgres');
    expect(hostedRoleFromUsername('zhiyu_app_web.otherproject')).toBeUndefined();
    expect(hostedRoleFromUsername('postgres.otherproject')).toBeUndefined();
  });
});
