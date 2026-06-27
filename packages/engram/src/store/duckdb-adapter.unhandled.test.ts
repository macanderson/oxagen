/**
 * Regression test: a DuckDB connection that fails to initialize (e.g. another
 * oxagen process already holds the single-writer file lock) must NOT escape as
 * an unhandled promise rejection that crashes the host process. The CLI opens
 * the store at startup and only awaits it lazily on the first prompt, so the
 * constructor's `ready` promise can reject while nothing is awaiting it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the native duckdb module so `conn.run` (used by initialize()) always
// errors with the exact DUCKDB connection failure the user hit.
vi.mock("duckdb", () => {
  const CONN_ERR = new Error(
    "Connection Error: Connection was never established or has been closed already",
  );
  class Connection {
    run(_sql: string, ...args: unknown[]) {
      const cb = args[args.length - 1] as (e: Error | null) => void;
      if (typeof cb === "function") cb(CONN_ERR);
    }
    all(_sql: string, ...args: unknown[]) {
      const cb = args[args.length - 1] as (e: Error | null, rows?: unknown[]) => void;
      if (typeof cb === "function") cb(CONN_ERR);
    }
    close(cb: (e: Error | null) => void) {
      cb(null);
    }
  }
  class Database {
    connect() {
      return new Connection();
    }
    close(cb: (e: Error | null) => void) {
      cb(null);
    }
  }
  return { default: { Database }, Database };
});

import { DuckDBEpisodicStore } from "./duckdb-adapter";

describe("DuckDBEpisodicStore — failed connection is non-fatal", () => {
  const captured: unknown[] = [];
  const onUnhandled = (e: unknown) => captured.push(e);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    captured.length = 0;
  });

  it("does not emit an unhandled rejection when initialization fails and is never awaited", async () => {
    process.on("unhandledRejection", onUnhandled);

    // Construct but DO NOT await anything — mirrors the CLI opening memory at
    // startup and only awaiting on the first prompt. Pre-fix, the rejecting
    // `ready` promise floated and crashed Node.
    const store = new DuckDBEpisodicStore({ path: ":memory:" });

    // Let microtasks + a macrotask flush so any unhandled rejection would fire.
    await new Promise((r) => setTimeout(r, 50));

    expect(captured).toEqual([]);

    // And callers that DO await still observe the failure (best-effort callers
    // wrap this in try/catch and degrade to no memory).
    await expect(store.append({} as never)).rejects.toThrow(/Connection/);
  });
});
