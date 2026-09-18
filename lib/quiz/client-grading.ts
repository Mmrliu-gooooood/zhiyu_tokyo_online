export interface ParsedQuizGradeResponse {
  score: number;
  comment: string;
  basis?: string;
}

export function parseQuizGradeResponse(value: unknown, points: number): ParsedQuizGradeResponse {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('success' in value) ||
    value.success !== true ||
    !('score' in value) ||
    typeof value.score !== 'number' ||
    !Number.isFinite(value.score) ||
    !Number.isInteger(value.score) ||
    value.score < 0 ||
    value.score > points ||
    !('comment' in value) ||
    typeof value.comment !== 'string' ||
    value.comment.length > 1_000 ||
    ('basis' in value && value.basis !== undefined && typeof value.basis !== 'string')
  ) {
    throw new Error('Invalid quiz grade response');
  }
  return {
    score: value.score,
    comment: value.comment,
    ...('basis' in value && typeof value.basis === 'string' && value.basis
      ? { basis: value.basis }
      : {}),
  };
}

/** Map in stable input order while bounding external grading work. */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
