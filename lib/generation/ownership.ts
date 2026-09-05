/** Browser-side generation gate shared by both classroom entry points and retries.
 * Server ownership survives completion, cancellation, failure and worker outages.
 * A missing producer on a successfully loaded legacy document means client.
 */
export function canGenerateLocally(state: {
  outlineProducer?: string | null;
  readOnly?: boolean;
  isOwner?: boolean;
}): boolean {
  return (
    (state.outlineProducer == null || state.outlineProducer === 'client') &&
    state.readOnly !== true &&
    state.isOwner !== false
  );
}
