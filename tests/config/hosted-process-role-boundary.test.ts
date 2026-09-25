import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('hosted Web/worker process boundary', () => {
  it('runs a Web app_web event bus while keeping background services in the worker', () => {
    const instrumentation = readFileSync('instrumentation.ts', 'utf8');
    const worker = readFileSync('workers/generation/main.ts', 'utf8');

    expect(instrumentation).toContain('isAgentRuntimeWorkerConfigured()');
    expect(instrumentation).toContain('getWebListenDatabaseUrl()');
    expect(instrumentation).toContain('startAgentEventNotifyBus({');
    expect(worker).toContain('startAgentRunner(');
    expect(worker).toContain('startMaterialExtractionRunner()');
    expect(worker).toContain('startAgentEventNotifyBus()');
    expect(worker).toContain('startAssetCollectorSchedule()');
  });

  it('ships filesystem-backed Pro runtime assets in the worker image', () => {
    const dockerfile = readFileSync('Dockerfile', 'utf8');

    expect(dockerfile).toContain('/app/skills/agent-runtime ./skills/agent-runtime');
    expect(dockerfile).toContain(
      '/app/lib/server/agent-runtime/import-pptx-worker.mjs ./lib/server/agent-runtime/import-pptx-worker.mjs',
    );
  });
});
