/** Redacted structural/data reconciliation. Does not contact either project. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('.scratch/supabase-tokyo-20260925');
const read = (...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));
const source = read('source-final', 'database-inventory.json'),
  target = read(process.argv[2] || 'target-restored', 'database-inventory.json');
const targetTables = new Map(target.tables.map((x) => [x.schema + '.' + x.table, x]));
const tableDiff = [];
for (const s of source.tables) {
  const name = s.schema + '.' + s.table,
    t = targetTables.get(name);
  if (!t || s.count !== t.count || s.sha256 !== t.sha256)
    tableDiff.push({ name, source: s, target: t });
}
const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    );
  // ACL entry ordering is insignificant.
  if (
    typeof value === 'string' &&
    value.startsWith('{') &&
    value.endsWith('}') &&
    value.includes('/')
  )
    return value.slice(1, -1).split(',').sort().join(',');
  return value;
};
const canonical = (x) => JSON.stringify(normalize(x));
const catalogDiff = {};
for (const [section, s] of Object.entries(source.catalog)) {
  const t = target.catalog[section];
  if (!Array.isArray(s) || !Array.isArray(t)) continue;
  const ss = new Set(s.map(canonical)),
    ts = new Set(t.map(canonical));
  const onlySource = s.filter((x) => !ts.has(canonical(x))),
    onlyTarget = t.filter((x) => !ss.has(canonical(x)));
  if (onlySource.length || onlyTarget.length) catalogDiff[section] = { onlySource, onlyTarget };
}
const report = {
  capturedAt: new Date().toISOString(),
  sourceTables: source.tables.length,
  targetTables: target.tables.length,
  tableDiff,
  catalogDiff,
};
writeFileSync(join(root, 'reconciliation.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify({
    sourceTables: source.tables.length,
    targetTables: target.tables.length,
    tableDiff: tableDiff.map((x) => ({
      name: x.name,
      sourceCount: x.source.count,
      targetCount: x.target?.count,
    })),
    catalogDiff: Object.fromEntries(
      Object.entries(catalogDiff).map(([k, v]) => [
        k,
        { source: v.onlySource.length, target: v.onlyTarget.length },
      ]),
    ),
  }),
);
