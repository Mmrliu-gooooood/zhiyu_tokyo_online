import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Generation Preview route/session boundary', () => {
  it('keeps the route page free of generation runtime and persistence ownership', () => {
    const route = read('app/generation-preview/page.tsx');

    expect(route).toContain("from './GenerationSessionController'");
    expect(route).not.toMatch(/['"]use client['"]/);
    expect(route).not.toContain('fetch(');
    expect(route).not.toContain('sessionStorage');
    expect(route).not.toContain('useStageStore');
    expect(route).not.toContain('AbortController');
  });

  it('exposes one named mount-scoped session controller as the route seam', () => {
    const controller = read('app/generation-preview/GenerationSessionController.tsx');

    expect(controller).toMatch(/export function GenerationSessionController\(\)/);
    expect(controller).toContain('new GenerationSessionRuntime({ onPhase: setCanonicalPhase })');
    expect(controller).toContain("canonicalPhase === 'scene-generation'");
    expect(controller).toContain('persistStageCandidate');
    expect(controller).not.toContain('saveStageData(');
    expect(controller).toContain('if (!generationRuntimeRef.current?.canAcceptIntent) return;');
    expect(controller).toContain('generationRuntimeRef.current?.stop()');
  });
});
