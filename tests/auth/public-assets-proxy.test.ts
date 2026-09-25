import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('hosted auth proxy public assets', () => {
  it('keeps brand images and fonts outside the login redirect matcher', () => {
    const source = readFileSync(resolve(process.cwd(), 'proxy.ts'), 'utf8');
    expect(source).toContain('svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|otf');
  });
});
