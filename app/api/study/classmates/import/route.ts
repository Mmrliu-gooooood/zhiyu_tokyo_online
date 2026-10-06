/**
 * POST { items: ClassmateInput[] } — turn roles the student created on this
 * device (before templates lived on the server) into templates, once. Items
 * already imported into this account are skipped.
 */
import { parseClassmateInput, type ClassmateInput } from '@/lib/study/classmates/contracts';
import { invalidInput, studyClassmatesRoute, studyJson } from '@/lib/server/study/route';
import { importClassmates } from '@/lib/server/study/classmates/repository';

export const runtime = 'nodejs';

const MAX_ITEMS = 10;
const MAX_BODY = 128 * 1024;

async function readItems(req: Request): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) return undefined;
  const raw = await req.text();
  if (raw.length > MAX_BODY) return undefined;
  try {
    return (JSON.parse(raw) as { items?: unknown } | null)?.items;
  } catch {
    return undefined;
  }
}

export function POST(req: Request) {
  return studyClassmatesRoute(req, async (ownerId, db, headers) => {
    const items = await readItems(req);
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) {
      return invalidInput('items', headers);
    }
    const inputs: ClassmateInput[] = [];
    for (const item of items) {
      const parsed = parseClassmateInput(item);
      if (!parsed.ok) return invalidInput(`items.${parsed.field}`, headers);
      inputs.push(parsed.value);
    }
    return studyJson(await importClassmates(db, ownerId, inputs), 200, headers);
  });
}
