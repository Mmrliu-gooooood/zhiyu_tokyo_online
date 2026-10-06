// Shared by the B03 eval, the study-knowledge tests and the local fake model
// server; the server is type-checked in the app image, where eval/ is absent.

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic stand-in for an embedding model (1024 dims, L2-normalized):
 * signed feature hashing of CJK unigrams/bigrams and Latin/number tokens. It
 * exercises the pipeline; it is not a measure of semantic quality.
 */
export function fakeEmbedding(text: string, dimensions = 1024): number[] {
  const vector = new Float64Array(dimensions);
  const lower = text.toLowerCase();
  const cjk = [...lower.replace(/[^\p{Script=Han}]+/gu, ' ')];
  const features: string[] = [];
  for (let i = 0; i < cjk.length; i += 1) {
    if (cjk[i] === ' ') continue;
    features.push(`u:${cjk[i]}`);
    if (cjk[i + 1] && cjk[i + 1] !== ' ') features.push(`b:${cjk[i]}${cjk[i + 1]}`);
  }
  for (const token of lower.match(/[a-z0-9_']+/g) ?? []) features.push(`w:${token}`);
  for (const feature of features) {
    const h = fnv(feature);
    vector[h % dimensions] += h & 0x80000000 ? -1 : 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
  return Array.from(vector, (x) => x / norm);
}
