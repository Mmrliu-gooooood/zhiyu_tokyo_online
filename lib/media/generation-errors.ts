/** Evidence supplied by a provider adapter, never inferred from error-message text. */
export class ConfirmedMediaFailure extends Error {
  readonly code: 'MEDIA_REQUEST_REJECTED' | 'MEDIA_TASK_FAILED';
  constructor(
    readonly outcome: 'rejected' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'ConfirmedMediaFailure';
    this.code = outcome === 'rejected' ? 'MEDIA_REQUEST_REJECTED' : 'MEDIA_TASK_FAILED';
  }
}

/** Only use on the generation POST, before any task/result has been accepted. */
export function mediaSubmissionError(status: number, message: string): Error {
  return [400, 401, 403, 404, 413, 415, 422, 429].includes(status)
    ? new ConfirmedMediaFailure('rejected', message)
    : new Error(message);
}
