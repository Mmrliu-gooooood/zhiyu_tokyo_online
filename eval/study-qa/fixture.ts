/**
 * B03 evaluation fixtures as the B02 parse would have stored them, plus a
 * deterministic stand-in embedding. Shared by the evaluation runner and the
 * server tests; no network, no model.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StoredArtifactDocument } from '@/lib/server/study/materials/artifact';

export interface FixturePage {
  text?: string;
  scanned?: boolean;
  tables?: { caption: string; cells: string[][] }[];
}

export interface FixtureVersion {
  no: number;
  pages: FixturePage[];
  images: { page: number; description: string }[];
}

export interface FixtureMaterial {
  key: string;
  owner: 'A' | 'B';
  title: string;
  versions: FixtureVersion[];
}

export interface FixtureQuestion {
  id: string;
  category: string;
  owner?: 'A' | 'B';
  question: string;
  answerable?: boolean;
  evidence: string[];
  requireAll?: boolean;
  scope?: { pin?: string[] };
  mention?: string[];
  note?: string;
}

export interface StudyQaFixture {
  owners: { A: string; B: string };
  materials: FixtureMaterial[];
  questions: FixtureQuestion[];
}

function here(): string {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

function readJson<T>(name: string): T {
  // Bundled runs (eval/study-qa/run.mjs) execute from .scratch/: fall back to the repo copy.
  const local = join(here(), 'fixtures', name);
  const path = existsSync(local) ? local : join(process.cwd(), 'eval/study-qa/fixtures', name);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** Corpus + distractors (single-version materials of account A) + questions. */
export function loadStudyQaFixture(): StudyQaFixture {
  const corpus = readJson<{ owners: StudyQaFixture['owners']; materials: FixtureMaterial[] }>(
    'corpus.json',
  );
  const distractors = readJson<{
    materials: { key: string; owner: 'A' | 'B'; title: string; pages: string[] }[];
  }>('distractors.json');
  const questions = readJson<{ questions: FixtureQuestion[] }>('questions.json').questions;
  return {
    owners: corpus.owners,
    materials: [
      ...corpus.materials,
      ...distractors.materials.map((material) => ({
        key: material.key,
        owner: material.owner,
        title: material.title,
        versions: [{ no: 1, pages: material.pages.map((text) => ({ text })), images: [] }],
      })),
    ],
    questions,
  };
}

/** The stored artifact document unpdf + B02 normalization would produce for a version. */
export function fixtureArtifact(version: FixtureVersion): StoredArtifactDocument {
  const blocks: StoredArtifactDocument['blocks'] = [];
  version.pages.forEach((page, index) => {
    const pageNumber = index + 1;
    if (page.scanned || !page.text?.trim()) return;
    blocks.push({ id: `page_${pageNumber}`, type: 'text', text: page.text, pageNumber });
    (page.tables ?? []).forEach((table, t) =>
      blocks.push({
        id: `table_${pageNumber}_${t + 1}`,
        type: 'table',
        text: table.caption,
        pageNumber,
        cells: table.cells,
      }),
    );
  });
  version.images.forEach((image, i) =>
    blocks.push({
      id: `block_img_${i + 1}`,
      type: 'image',
      imageId: `img_${i + 1}`,
      text: image.description,
      pageNumber: image.page,
    }),
  );
  return {
    version: 1,
    transform: 'study-artifact-v1',
    extractorId: 'unpdf',
    extractorVersion: 'fixture',
    mimeType: 'application/pdf',
    pageCount: version.pages.length,
    paged: true,
    blocks,
    images: version.images.map((image, i) => ({
      id: `img_${i + 1}`,
      key: `fixture/img_${i + 1}.png`,
      mimeType: 'image/png',
      pageNumber: image.page,
      description: image.description,
    })),
    diagnostics: [],
  };
}

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

/** material@version#page of a cited/retrieved location. */
export function locationRef(materialKey: string, versionNo: number, page: number | null): string {
  return `${materialKey}@${versionNo}#${page ?? 0}`;
}
