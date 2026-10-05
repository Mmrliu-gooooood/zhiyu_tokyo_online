/**
 * Study material library contract (learning plan B02). Client-safe: plain
 * data types, limits and pure helpers only.
 *
 * Terms
 * - material: one long-lived item in the owner's library ("高数教材").
 * - version: one immutable uploaded file of a material. Replacing the file
 *   adds a version; the older version and anything that points at it stay
 *   readable.
 * - artifact: the normalized parse result of one version by one parser
 *   (blocks with page numbers where the parser provides them). Raw upload and
 *   parse are separate states: uploaded does not mean parsed.
 */
import type { LearningTaskView } from '@/lib/study/tasks/contracts';

export const STUDY_MATERIAL_LIMITS = {
  titleMax: 120,
  maxMaterialsPerOwner: 200,
  maxVersionsPerMaterial: 20,
  maxMaterialsPerSpace: 100,
  /** Largest parsed text a reader or generation request returns in one response. */
  maxTextChars: 2_000_000,
} as const;

/** Document and image types the study library accepts (audio/video stay in the workbench). */
export const STUDY_MATERIAL_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
] as const;

export const STUDY_MATERIAL_ACCEPT = [
  '.pdf',
  '.pptx',
  '.docx',
  '.xlsx',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  ...STUDY_MATERIAL_MIME_TYPES,
].join(',');

export function isStudyMaterialMime(mime: string): boolean {
  return (STUDY_MATERIAL_MIME_TYPES as readonly string[]).includes(mime.trim().toLowerCase());
}

/** Browsers often send markdown/csv as octet-stream or text/plain; trust the extension for those. */
export function studyMaterialMimeForFile(file: { name: string; type: string }): string {
  const name = file.name.toLowerCase();
  if (name.endsWith('.md') || name.endsWith('.markdown')) return 'text/markdown';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.txt')) return 'text/plain';
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.docx'))
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (name.endsWith('.pptx'))
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (name.endsWith('.xlsx'))
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return (file.type || 'application/octet-stream').toLowerCase();
}

/** Formats the reader can show as the original file in the page (others: download + parsed text). */
export function readerOriginalKind(mime: string): 'pdf' | 'image' | 'text' | 'download' {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/')) return 'text';
  return 'download';
}

export type MaterialParseState =
  | 'not_started'
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface MaterialParserOption {
  providerId: string;
  displayName: string;
  /** Has OCR / tables / formulas / layout according to the extractor manifest. */
  capabilities: { ocr: boolean; tables: boolean; formulas: boolean; layout: boolean };
  /** Calls a paid external service; only used when the user picks it. */
  paid: boolean;
  /** Server has this parser configured (keys / base URL present). */
  available: boolean;
  /** Free default for this file type. */
  isDefault: boolean;
}

export interface StudyMaterialArtifactView {
  artifactId: string;
  extractorId: string;
  extractorVersion: string;
  pageCount: number;
  textChars: number;
  imageCount: number;
  /** Blocks carry page numbers, so the reader can jump by page. */
  paged: boolean;
  diagnostics: string[];
  createdAt: string;
}

export interface StudyMaterialVersionView {
  versionId: string;
  /** The owner upload behind this version (what workbench sessions bind by reference). */
  uploadId: string;
  versionNo: number;
  originalName: string;
  mime: string;
  byteSize: number;
  createdAt: string;
  isCurrent: boolean;
  parseState: MaterialParseState;
  artifact: StudyMaterialArtifactView | null;
  /** Newest parse task of this version, if any. */
  latestTask: LearningTaskView | null;
}

export interface StudyMaterialSpaceRef {
  spaceId: string;
  name: string;
}

export interface StudyMaterialSummary {
  materialId: string;
  title: string;
  revision: number;
  versionCount: number;
  current: StudyMaterialVersionView;
  spaces: StudyMaterialSpaceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface StudyMaterialDetail extends StudyMaterialSummary {
  versions: StudyMaterialVersionView[];
  /** Agent sessions that read a version of this material by reference. */
  sessionRefCount: number;
}

/** Same bytes already in the owner's library (never across owners). */
export interface StudyMaterialDuplicateHint {
  materialId: string;
  title: string;
  versionNo: number;
}

export interface StudyMaterialUploadResult {
  material: StudyMaterialDetail;
  versionId: string;
  duplicateOf: StudyMaterialDuplicateHint | null;
  /** Parse was requested but could not be queued (e.g. queue full, worker offline). */
  parseNotStarted: string | null;
}

export interface ReaderBlock {
  id: string;
  type: 'text' | 'markdown' | 'image' | 'table' | 'formula' | 'layout';
  text?: string;
  html?: string;
  pageNumber?: number;
  bbox?: { x: number; y: number; width: number; height: number };
  /** For image blocks: the artifact image served by the reader image endpoint. */
  imageId?: string;
}

/** An image the parse extracted, as course generation reuses it (bytes via the image endpoint). */
export interface StudyMaterialImageInfo {
  id: string;
  mimeType: string;
  pageNumber?: number;
  width?: number;
  height?: number;
  description?: string;
}

/** The reusable parse output of one version: text plus the images it extracted. */
export interface StudyMaterialTextView {
  materialId: string;
  versionId: string;
  versionNo: number;
  name: string;
  title: string;
  artifactId: string | null;
  pageCount: number;
  text: string;
  truncated: boolean;
  images: StudyMaterialImageInfo[];
}

export interface ReaderPageView {
  materialId: string;
  versionId: string;
  versionNo: number;
  title: string;
  originalName: string;
  mime: string;
  isCurrent: boolean;
  artifactId: string;
  extractorId: string;
  paged: boolean;
  pageCount: number;
  /** Requested page (1-based) for paged artifacts; null when the artifact has no pages. */
  page: number | null;
  blocks: ReaderBlock[];
  /** True when the unpaged text was cut at the response limit. */
  truncated: boolean;
}

/** Display parse state from the version's artifact and newest task. */
export function parseStateOf(
  artifact: StudyMaterialArtifactView | null,
  task: LearningTaskView | null,
): MaterialParseState {
  if (
    task &&
    (task.status === 'queued' || task.status === 'running' || task.status === 'retry_wait')
  )
    return task.status;
  if (artifact) return 'succeeded';
  if (task) return task.status === 'succeeded' ? 'succeeded' : task.status;
  return 'not_started';
}

export function isValidMaterialTitle(title: unknown): title is string {
  return (
    typeof title === 'string' &&
    title.trim().length > 0 &&
    title.trim().length <= STUDY_MATERIAL_LIMITS.titleMax
  );
}
