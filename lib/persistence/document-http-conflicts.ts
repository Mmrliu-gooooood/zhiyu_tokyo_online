import type {
  DocumentHttpMapStoreConflict,
  DocumentHttpStoreConflict,
} from '@openmaic/storage/server';

import { GenerationJobError } from '@/lib/server/generation-jobs/contracts';

const SERVER_OWNED_GENERATION_CONFLICT = {
  code: 'SERVER_OWNED_GENERATION',
  message: 'Course generation currently owns this document; refresh before editing.',
} as const satisfies DocumentHttpStoreConflict;

/**
 * The allowlist lives at the application boundary. The generic storage package
 * never inspects arbitrary `code`/`httpStatus` properties from an exception.
 */
export function createPersistenceDocumentConflictMapper(
  requestId: string,
): DocumentHttpMapStoreConflict {
  return (error, context) => {
    if (
      !(error instanceof GenerationJobError) ||
      error.code !== SERVER_OWNED_GENERATION_CONFLICT.code
    ) {
      return undefined;
    }

    // Deliberately structured and redacted: do not log the exception message,
    // request body, auth headers, or document content.
    console.warn('[persistence] document write conflict', {
      requestId,
      stageId: context.stageId,
      operation: context.operation,
      code: SERVER_OWNED_GENERATION_CONFLICT.code,
    });
    return SERVER_OWNED_GENERATION_CONFLICT;
  };
}
