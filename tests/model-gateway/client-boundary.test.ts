/**
 * The gateway's client surface (types + catalog) must not reach the pi-ai
 * runtime or any server-only gateway module through VALUE imports (plan 3.2,
 * invariant 14). The lint rule stops client files from importing the server
 * surface directly; this test follows the transitive import graph so an
 * indirect path (catalog → helper → runtime) is caught too.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const CLIENT_ROOTS = [
  'lib/model-gateway/types.ts',
  ...readdirSync(path.join(ROOT, 'lib/model-gateway/catalog'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `lib/model-gateway/catalog/${name}`),
];

const FORBIDDEN_PACKAGES = [
  /^@earendil-works\/pi-ai(?:\/|$)/,
  /^@ai-sdk\//,
  /^@earendil-works\/pi-agent-core/,
];
const FORBIDDEN_MODULES =
  /^lib\/model-gateway\/(?:runtime|credentials|selection|adapters|testing|auth)\/|^lib\/model-gateway\/index\.ts$|^lib\/server\//;

function resolveModule(from: string, specifier: string): string | undefined {
  const base = specifier.startsWith('@/')
    ? path.join(ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(path.join(ROOT, from)), specifier)
      : undefined;
  if (!base) return undefined;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && /\.(tsx?|json)$/.test(candidate)) {
      return path.relative(ROOT, candidate).split(path.sep).join('/');
    }
  }
  return undefined;
}

/** Module specifiers imported or re-exported as values (type-only forms skipped). */
function valueImports(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(path.join(ROOT, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  source.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
  });
  return specifiers;
}

describe('model gateway client surface', () => {
  it('never reaches the pi-ai runtime or server-only modules through value imports', () => {
    const seen = new Set<string>();
    const violations: string[] = [];
    const queue = [...CLIENT_ROOTS];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file) || file.endsWith('.json')) continue;
      seen.add(file);
      for (const specifier of valueImports(file)) {
        if (FORBIDDEN_PACKAGES.some((pattern) => pattern.test(specifier))) {
          violations.push(`${file} → ${specifier}`);
          continue;
        }
        const resolved = resolveModule(file, specifier);
        if (!resolved) continue;
        if (FORBIDDEN_MODULES.test(resolved)) violations.push(`${file} → ${resolved}`);
        else queue.push(resolved);
      }
    }
    expect(seen.size).toBeGreaterThan(CLIENT_ROOTS.length);
    expect(violations).toEqual([]);
  });
});
