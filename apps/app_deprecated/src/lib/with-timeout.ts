import { logger } from "@oxagen/handlers/logger";

/**
 * Race `work` against a bounded timer, resolving to `fallback` when the timer
 * wins. A caller's try/catch covers a dependency that *rejects*; this covers
 * the pathological case a catch can't: a promise that never settles and would
 * otherwise block a server render forever. Page-blocking reads must never hang
 * the whole page; the affected panel degrades to its fallback instead.
 *
 * This is the ONE implementation — `lib/workbench/equip-sources.ts` calls it
 * with its own tighter budget rather than keeping a private copy.
 */
export const PAGE_READ_TIMEOUT_MS = 10_000;

export async function withTimeout<T>(
  work: Promise<T>,
  fallback: T,
  label: string,
  timeoutMs: number = PAGE_READ_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(
        { label, timeoutMs },
        "with-timeout: page read timed out — degrading to fallback",
      );
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
