export type AccessCodeVisualState = 'initial' | 'invalid' | 'loading' | 'success';

/**
 * Maps the existing access-code request flags to a stable presentation state.
 * The projection is intentionally stateless: request ownership remains in the
 * modal and the server continues to decide whether a code is valid.
 */
export function projectAccessCodeVisualState({
  error,
  loading,
  success,
}: {
  readonly error: string;
  readonly loading: boolean;
  readonly success: boolean;
}): AccessCodeVisualState {
  if (success) return 'success';
  if (loading) return 'loading';
  if (error) return 'invalid';
  return 'initial';
}
