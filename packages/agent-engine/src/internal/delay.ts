/**
 * An abortable sleep.
 *
 * Rejects on abort rather than resolving early, so a caller cannot mistake a
 * cancelled wait for a completed one.
 */
/** Resolve after `ms`, rejecting early with an AbortError if `signal` fires. */
export function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  // An ALREADY-aborted signal must reject immediately — `addEventListener("abort")`
  // never fires for an abort that has already been dispatched, so without this
  // guard an already-aborted turn would sit through the full backoff before its
  // caller's catch/break could fire. Both callers (engine.ts retry backoff,
  // tools.ts file-lock acquire retry) already break on this rejection.
  if (signal?.aborted) {
    return Promise.reject(
      new DOMException("Aborted before backoff.", "AbortError"),
    );
  }
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted during backoff.", "AbortError"));
      },
      { once: true },
    );
  });
}
