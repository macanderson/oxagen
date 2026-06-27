/**
 * Regression test: a ClickHouse store whose initialization fails (the target
 * database does not exist, or ClickHouse is unreachable) must NOT escape as an
 * unhandled promise rejection that fails the whole test run / crashes the host
 * process. The constructor kicks off `CREATE TABLE` via `this.ready` and callers
 * only await it lazily on the first read/write — so `ready` can reject while
 * nothing is awaiting it. Pre-fix, that surfaced in CI as
 * "Database <db> does not exist" reaching `unhandledRejection` and failing the
 * run even though every test passed (mirrors the DuckDB guard).
 */
import { describe, it, expect, afterEach } from "vitest";
import { ClickHouseEpisodicStore } from "./clickhouse-adapter";

describe("ClickHouseEpisodicStore — failed init is non-fatal", () => {
  const captured: unknown[] = [];
  const onUnhandled = (e: unknown) => captured.push(e);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    captured.length = 0;
  });

  it("never emits an unhandled rejection when init fails and is never awaited", async () => {
    process.on("unhandledRejection", onUnhandled);

    // Unreachable endpoint → the constructor's CREATE TABLE command rejects
    // (connection refused). Construct but DO NOT await — mirrors the factory
    // path that instantiates the store and hands it back without touching it.
    const store = new ClickHouseEpisodicStore({
      url: "http://127.0.0.1:9",
      username: "default",
      password: "",
      database: "no_such_db_engram_regression",
    });

    // Flush microtasks + a macrotask so any floating rejection would fire.
    await new Promise((r) => setTimeout(r, 300));

    // Non-vacuous: confirm init genuinely failed — a consumer awaiting `ready`
    // (getById awaits ready, then queries) observes the rejection.
    let failed = false;
    await store.getById("x").then(
      () => {},
      () => {
        failed = true;
      },
    );
    expect(failed).toBe(true);

    // The guarantee: that failure never escaped as an unhandled rejection.
    expect(captured).toEqual([]);

    await store.close().catch(() => {});
  });
});
