/**
 * Regression test: a DuckDB store whose connection fails to initialize (e.g.
 * another oxagen process already holds the single-writer file lock, or the path
 * is unopenable) must NOT escape as an unhandled promise rejection that crashes
 * the host process. The CLI opens the store at startup and only awaits it lazily
 * on the first prompt, so the constructor's `ready` promise can reject while
 * nothing is awaiting it — pre-fix that crashed Node with a DUCKDB_NODEJS_ERROR.
 */
import { describe, it, expect, afterEach } from "vitest";
import { DuckDBEpisodicStore } from "./duckdb-adapter";

describe("DuckDBEpisodicStore — failed connection is non-fatal", () => {
  const captured: unknown[] = [];
  const onUnhandled = (e: unknown) => captured.push(e);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    captured.length = 0;
  });

  it("never emits an unhandled rejection when initialization fails and is never awaited", async () => {
    process.on("unhandledRejection", onUnhandled);

    // Path under a directory that does not exist → DuckDB cannot open/create the
    // file. Construct but DO NOT await — mirrors the CLI opening memory at
    // startup and only awaiting on the first prompt. The failure may surface
    // synchronously (constructor throws — handled by callers' try/catch) or
    // asynchronously via the `ready` promise (must be caught by the in-adapter
    // guard). Either way, nothing should reach `unhandledRejection`.
    let store: DuckDBEpisodicStore | undefined;
    try {
      store = new DuckDBEpisodicStore({
        path: "/no_such_dir_oxagen_regression_test/context.duckdb",
      });
    } catch {
      /* synchronous open failure is acceptable — callers wrap construction */
    }

    // Flush microtasks + a macrotask so any floating rejection would fire.
    await new Promise((r) => setTimeout(r, 100));

    // Non-vacuous: confirm the connection genuinely failed. Either construction
    // threw synchronously, or a consumer awaiting `ready` observes the rejection
    // (getById only awaits ready then queries — a clean signal, no record munging).
    let failed = !store;
    if (store) {
      await store.getById("x").then(
        () => {},
        () => {
          failed = true;
        },
      );
    }
    expect(failed).toBe(true);

    // The guarantee: that failure never escaped as an unhandled rejection.
    expect(captured).toEqual([]);

    await store?.close().catch(() => {});
  });
});
