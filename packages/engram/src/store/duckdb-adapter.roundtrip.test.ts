/**
 * What a record looks like coming back OUT of a real DuckDB store.
 *
 * The adapter's other tests write and read and compare fields, which passes
 * whether a numeric field comes back as `42` or as `42n` — `toBe` on a number
 * read from the same row is true either way once both sides are bigints. So
 * two things went unnoticed for as long as the adapter existed:
 *
 *  - `created_at` and `ttl` are BIGINT columns, and DuckDB returns those as
 *    JavaScript BigInt. `rowToRecord` cast them to `number`, which is a
 *    compile-time claim and no runtime conversion, so every stored record came
 *    back with a bigint in a field the type and the zod schema both call a
 *    number. `new Date(record.createdAt)` threw, and
 *    `MemoryRecordSchema.parse` rejected the store's own output.
 *  - The store could not be opened from an ESM process at all: the constructor
 *    used a bare `require`, which is not defined in this package's own module
 *    system. Vitest's runner supplies one, so it never showed up here — see
 *    `duckdb-adapter.esm.test.ts`, which starts a real process.
 *
 * Both are checked against a real database, because a fake store is exactly
 * what cannot show either one.
 */
import { describe, expect, it } from "vitest";
import { createStore } from "./index";
import { NativeModuleUnavailableError } from "./errors";
import { createRecord } from "../record";
import { MemoryRecordSchema } from "../types";
import type { EpisodicStore, MemoryRecord } from "../index";

const NAMESPACE = { org: "acme", workspace: "platform" };

function record(
  overrides: { ttl?: number; event?: string } = {},
): MemoryRecord {
  return createRecord({
    kind: "episodic",
    namespace: NAMESPACE,
    body: {
      event: overrides.event ?? "deploy",
      payload: { text: "the deploy failed at 3am" },
    },
    salience: 0.7,
    confidence: 1,
    provenance: {
      author: "agent:test",
      derivedFrom: [],
      timestamp: 1_700_000_000_000,
    },
    causality: [],
    ...(overrides.ttl !== undefined ? { ttl: overrides.ttl } : {}),
  });
}

/**
 * A store, or null when the optional native module is genuinely missing. The
 * distinction matters: a suite that treats "not installed" the same as "broken"
 * either fails everywhere the module is absent or passes everywhere it is
 * present but wrong.
 */
function openStore(): EpisodicStore | null {
  try {
    return createStore({ duckdbPath: ":memory:" });
  } catch (err) {
    if (err instanceof NativeModuleUnavailableError) return null;
    throw err;
  }
}

describe("a record read back from a real DuckDB store", () => {
  const store = openStore();
  const withStore = store ? it : it.skip;

  withStore("comes back as the numbers its own schema requires", async () => {
    const written = record({ ttl: 1_800_000_000_000 });
    await store!.appendBatch([written]);

    const [read] = await store!.query({ namespace: NAMESPACE, limit: 10 });
    expect(read).toBeDefined();

    expect(typeof read!.createdAt).toBe("number");
    expect(typeof read!.ttl).toBe("number");
    // The schema is the contract every consumer relies on, and it rejected the
    // store's own output.
    expect(() => MemoryRecordSchema.parse(read)).not.toThrow();
  });

  withStore("carries a createdAt a Date can be built from", async () => {
    await store!.appendBatch([record()]);
    const [read] = await store!.query({ namespace: NAMESPACE, limit: 10 });
    expect(() => new Date(read!.createdAt).toISOString()).not.toThrow();
  });

  withStore("leaves an absent ttl absent rather than zero", async () => {
    await store!.appendBatch([record({ event: "no-ttl" })]);
    const rows = await store!.query({ namespace: NAMESPACE, limit: 50 });
    const noTtl = rows.find(
      (r) => (r.body as { event: string }).event === "no-ttl",
    );
    expect(noTtl?.ttl).toBeUndefined();
  });
});
