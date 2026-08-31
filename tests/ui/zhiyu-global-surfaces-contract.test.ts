import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

describe('ZHIYU global surface contract', () => {
  it('keeps route suspense states visible and branded', () => {
    const workspace = source('app/workspace/page.tsx');
    const bridge = source('app/workbench/new/page.tsx');

    expect(workspace).not.toContain('fallback={null}');
    expect(bridge).not.toContain('fallback={null}');
    expect(workspace).toContain('workspace-route-loading');
    expect(bridge).toContain('workbench-bridge-loading');
  });

  it('exposes forwarding, failure and retry bridge states without a second composer', () => {
    const bridge = source('app/workbench/new/client.tsx');

    expect(bridge).toContain('workbench-bridge-forwarding');
    expect(bridge).toContain('workbench-bridge-error');
    expect(bridge).toContain('workbench-bridge-retry');
    expect(bridge).toContain('role="alert"');
    expect(bridge).not.toContain('<textarea');
  });

  it('uses the single brand source for metadata and route status surfaces', () => {
    const layout = source('app/layout.tsx');
    const routeLoading = source('components/brand/ZhiyuRouteLoading.tsx');

    expect(layout).toContain("icon: '/zhiyu-mark.svg'");
    expect(layout).toContain("applicationName: '智域'");
    expect(routeLoading).toContain('<ZhiyuLockup');
    expect(routeLoading).toContain('role="status"');
  });
});
