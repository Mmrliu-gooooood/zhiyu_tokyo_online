/**
 * Client-facing selection errors. Codes and HTTP statuses match the legacy
 * resolver (lib/server/resolve-model.ts) so routes keep their responses.
 */
export type ModelSelectionErrorCode =
  | 'INVALID_MODEL_SOURCE'
  | 'INVALID_MODEL_SELECTION'
  | 'MISSING_MODEL'
  | 'PLATFORM_DEFAULT_REVISION_MISMATCH';

export class ModelSelectionError extends Error {
  constructor(
    readonly code: ModelSelectionErrorCode,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'ModelSelectionError';
  }
}
