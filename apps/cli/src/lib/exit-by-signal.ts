/**
 * exit-by-signal.ts — die by re-raised signal instead of `process.exit()`.
 *
 * Why this exists: calling `process.exit()` from a SIGINT/SIGTERM handler runs
 * libc's `exit()`, which walks C++ static destructors (`__cxa_finalize`) of
 * every loaded native addon. The CLI loads native thread-pool libraries —
 * DuckDB (`TaskScheduler::ExecuteForever` workers for the code graph / engram
 * stores) and onnxruntime (fastembed's local embedder) — whose worker threads
 * are still running at that moment. A destructor tearing down a `std::mutex`
 * that a live worker then locks aborts the whole process:
 *
 *   libc++abi: terminating due to uncaught exception of type
 *   std::__1::system_error: mutex lock failed: Invalid argument
 *
 * (macOS crash report 2026-07-09: SignalWrap → JS handler → Environment::Exit
 * → __cxa_finalize_ranges → std::terminate → SIGABRT, with nine live
 * `duckdb::TaskScheduler` threads.)
 *
 * The POSIX-correct way for a handler to terminate after cleanup is to
 * restore the default disposition and re-raise the same signal. Signal death
 * skips `exit()`-time destructor teardown entirely — no native library can
 * abort — and the parent still observes the conventional 128+n status
 * (130 for SIGINT, 143 for SIGTERM), same as the old `process.exit(130|143)`.
 *
 * Callers MUST have finished their synchronous cleanup (leave alt-screen,
 * reap children) before calling this: nothing after the re-raise runs.
 */

/** Signals the CLI handles with an explicit terminate-after-cleanup path. */
export type TerminalSignal = "SIGINT" | "SIGTERM";

/** Conventional 128+n exit code for a signal, used only by the fallback path. */
export function signalExitCode(signal: TerminalSignal): number {
  return signal === "SIGINT" ? 130 : 143;
}

/**
 * Terminate the process *by* `signal`: drop every JS listener for it (which
 * restores the OS default disposition) and re-raise it at ourselves. Never
 * returns on the happy path. Two nets keep termination guaranteed:
 *
 * - `process.kill` throwing (exotic platform/emulation) falls straight back
 *   to `process.exit`.
 * - If the re-raised signal is somehow swallowed, an unref'd timer hard-exits
 *   shortly after — worst case is exactly the old `process.exit` behavior.
 */
export function exitBySignal(signal: TerminalSignal): void {
  const code = signalExitCode(signal);
  try {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } catch {
    process.exit(code);
  }
  const net = setTimeout(() => process.exit(code), 500);
  // Node's Timeout has unref(); guard anyway so a test double can't crash us.
  net.unref?.();
}
