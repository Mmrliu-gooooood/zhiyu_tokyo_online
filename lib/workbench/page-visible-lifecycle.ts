/** Release long-lived HTTP/1.1 streams while a tab cannot display their events. */
export function whilePageVisible(start: () => () => void): () => void {
  let cleanup: (() => void) | undefined;
  let disposed = false;
  const update = () => {
    if (disposed) return;
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    if (visible) cleanup ??= start();
    else {
      cleanup?.();
      cleanup = undefined;
    }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', update);
  update();
  return () => {
    disposed = true;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', update);
    cleanup?.();
    cleanup = undefined;
  };
}
