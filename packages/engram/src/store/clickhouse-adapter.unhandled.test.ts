/**
 * Regression test: a ClickHouse store whose connection fails to initialize (e.g.
 * ClickHouse is unreachable in a local/CI environment without the datastore) must
 * NOT escape as an unhandled promise rejection that crashes the host process. The
 * store is opened eagerly at startup and only awaited lazily on first use, so the
 * constructor's `ready` promise can reject while nothing is awaiting it — pre-fix
 * that surfaced as an unhandled ECONNREFUSED and failed the whole vitest run.
 *
 * Mirrors duckdb-adapter.unhandled.test.ts for the ClickHouse adapter.
 */
import { describe, it, expect, afterEach } from "vitest";
import { ClickHouseEpisodicStore } from "./clickhouse-adapter";

describe("ClickHouseEpisodicStore — failed connection is non-fatal", () => {
  const captured: unknown[] = [];
  const onUnhandled = (e: unknown) => captured.push(e);

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    captured.length = 0;
  });

  it("never emits an unhandled rejection when initialization fails and is never awaited", async () => {
    process.on("unhandledRejection", onUnhandled);

    // Point at an unreachable endpoint so the constructor's `initialize()` (a
    // CREATE TABLE command) rejects with a connection error. Construct but DO NOT
    // await — mirrors the runtime opening memory at startup and awaiting only on
    // first use. The floating `ready` rejection must be caught by the in-adapter
    // guard, never reaching `unhandledRejection`.
    const store = new ClickHouseEpisodicStore({
      url: "http://127.0.0.1:1",
      username: "default",
      password: "",
      database: "test",
    });

    // Flush microtasks + a macrotask so any floating rejection would fire.
    await new Promise((r) => setTimeout(r, 100));

    // Non-vacuous: confirm the connection genuinely failed — a consumer awaiting
    // `ready` (getById awaits ready then queries) observes the rejection.
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
