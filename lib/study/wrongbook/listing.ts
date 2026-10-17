/**
 * Filtering, ordering and facet counts of a space's wrong items (learning
 * plan B10). Pure: the server reads one small row per visible item (a space
 * keeps at most WRONGBOOK_LIMITS.itemsPerSpace) and pages here.
 */
import {
  WRONGBOOK_LIMITS,
  WRONG_SOURCE_TYPES,
  type WrongReviewState,
  type WrongSourceType,
  type WrongbookFacets,
  type WrongbookFilter,
} from './contracts';

export interface WrongItemRow {
  id: string;
  sourceType: WrongSourceType;
  reviewState: WrongReviewState;
  archived: boolean;
  concepts: string[];
  /** Wrong answers (≥ 1 for a listed item). */
  wrongCount: number;
  lastWrongAt: string;
}

const DAY = 86_400_000;

function inState(row: WrongItemRow, state: WrongbookFilter['state']): boolean {
  if (state === 'archived') return row.archived;
  if (row.archived) return false;
  return state === 'active' || row.reviewState === 'to_review';
}

export function listWrongItems<T extends WrongItemRow>(
  rows: readonly T[],
  filter: WrongbookFilter,
  now: number = Date.now(),
): { page: T[]; total: number; nextOffset: number | null; facets: WrongbookFacets } {
  const listed = rows.filter((row) => row.wrongCount > 0);
  const since = filter.since === 'all' ? null : now - (filter.since === '7d' ? 7 : 30) * DAY;
  const scoped = listed.filter(
    (row) => inState(row, filter.state) && (since === null || Date.parse(row.lastWrongAt) >= since),
  );
  const conceptCounts = new Map<string, number>();
  const sources = Object.fromEntries(WRONG_SOURCE_TYPES.map((type) => [type, 0])) as Record<
    WrongSourceType,
    number
  >;
  let unlinked = 0;
  for (const row of scoped) {
    sources[row.sourceType] += 1;
    if (row.concepts.length === 0) unlinked += 1;
    for (const concept of row.concepts) {
      conceptCounts.set(concept, (conceptCounts.get(concept) ?? 0) + 1);
    }
  }
  const matched = scoped
    .filter(
      (row) =>
        (filter.source === null || row.sourceType === filter.source) &&
        (filter.concept === null ||
          (filter.concept === ''
            ? row.concepts.length === 0
            : row.concepts.includes(filter.concept))),
    )
    .sort(
      (a, b) => Date.parse(b.lastWrongAt) - Date.parse(a.lastWrongAt) || a.id.localeCompare(b.id),
    );
  const page = matched.slice(filter.offset, filter.offset + WRONGBOOK_LIMITS.pageSize);
  const end = filter.offset + page.length;
  return {
    page,
    total: matched.length,
    nextOffset: end < matched.length ? end : null,
    facets: {
      concepts: [...conceptCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      sources,
      states: {
        active: listed.filter((row) => !row.archived).length,
        toReview: listed.filter((row) => !row.archived && row.reviewState === 'to_review').length,
        archived: listed.filter((row) => row.archived).length,
      },
      unlinked,
    },
  };
}
