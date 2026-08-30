/**
 * Coalesces rapid-fire transcript re-renders onto a fixed frame cadence.
 *
 * Every streamed delta (a reasoning token, an assistant-text token, a tool
 * chip update — see interactive.tsx's `render()` closure inside the turn
 * handler) would otherwise call `commit()` directly, which does
 * `allRef.current = next; setMessages(next);` — i.e. one full Ink re-render
 * of the entire transcript PER TOKEN. A fast model call can stream dozens of
 * tokens a second, so that would be dozens of Ink reconciliations a second for
 * content the user perceives as a single smooth stream.
 *
 * This helper is a pure, framework-free coalescer (no Ink, no React — just
 * `setTimeout`) so it unit-tests deterministically under fake timers:
 * rapid-fire `schedule()` calls within one frame window collapse into a
 * single `commitFn` call at the end of the window, and a final `flush()` at
 * turn end guarantees the very last tokens land immediately with no pending
 * timer left dangling.
 *
 * Usage (see interactive.tsx):
 *
 *   const throttle = createRenderThrottle<Message[]>(commit);
 *   const render = (): void => throttle.schedule(() => [...base, ...turn]);
 *   ...
 *   } finally {
 *     throttle.flush(() => [...base, ...turn]); // final, untrottled commit
 *   }
 *
 * `schedule` is called on every streamed delta; `flush` is called exactly
 * once, at turn end (success, error, or cancel), and `cancel` is called on
 * unmount so a torn-down component never receives a late `setState`.
 */
export interface RenderThrottle<T> {
  /**
   * Mark the throttle dirty and, if no flush is currently armed for this
   * frame window, schedule one via `setTimeout(frameMs)`. `getLatest` is
   * stashed, not invoked synchronously — it is called only when the timer
   * actually fires, so it MUST return the current, live state at that time
   * (e.g. `() => [...base, ...turn]`), never a snapshot captured up front:
   * `turn` mutates between when `schedule` is called and when the timer
   * fires, and the whole point of this helper is to commit whatever is
   * freshest at flush time, not whatever was freshest at schedule time.
   */
  schedule(getLatest: () => T): void;
  /**
   * Commit the latest state immediately and synchronously, cancelling any
   * pending frame timer first. Safe to call whether or not a flush is
   * currently dirty/armed — always commits exactly once.
   */
  flush(getLatest: () => T): void;
  /** Cancel any pending frame timer WITHOUT committing. Idempotent. */
  cancel(): void;
}

export interface RenderThrottleOptions {
  /** Frame window in ms. Defaults to ~33ms (approx. 30fps). */
  frameMs?: number;
}

const DEFAULT_FRAME_MS = 33;

/**
 * Build a throttle that coalesces calls to `schedule` onto one `commitFn`
 * invocation per `frameMs` window.
 */
export function createRenderThrottle<T>(
  commitFn: (value: T) => void,
  options?: RenderThrottleOptions,
): RenderThrottle<T> {
  const frameMs = options?.frameMs ?? DEFAULT_FRAME_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  // The most recently scheduled `getLatest` closure — always overwritten by
  // the newest call so the eventual flush reads the freshest state.
  let latestGetter: (() => T) | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (getLatest: () => T): void => {
    latestGetter = getLatest;
    dirty = true;
    // A timer is already armed for this frame window — the pending fire will
    // pick up this newer `getLatest` when it runs. Do not stack a second one.
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty && latestGetter) {
        dirty = false;
        const getter = latestGetter;
        latestGetter = null;
        commitFn(getter());
      }
    }, frameMs);
  };

  const flush = (getLatest: () => T): void => {
    clearTimer();
    dirty = false;
    latestGetter = null;
    commitFn(getLatest());
  };

  const cancel = (): void => {
    clearTimer();
    dirty = false;
    latestGetter = null;
  };

  return { schedule, flush, cancel };
}
