/**
 * The workspace's steering records, compiled into the bundle's
 * `context.system` (ADR-091). The text is part of the bundle etag, so it has
 * to be deterministic, and the host rejects the whole bundle past 16,384
 * characters, so it has to stay under that.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { policyBundleSchema } from "@oxagen/oxagen/tacho/schemas";
import {
  CONTEXT_SYSTEM_MAX_CHARS,
  STEERING_CACHE_MAX_ENTRIES,
  classificationOf,
  clearSteeringCacheForTests,
  compileSteering,
  readWorkspaceSteering,
  type SteeringRecord,
  type SteeringRow,
  type SteeringTx,
} from "./tacho-steering";
import { unsignedBundle } from "./tacho-host";

function rec(overrides: Partial<SteeringRecord>): SteeringRecord {
  return {
    slug: "a-record",
    kind: "rule",
    force: "must",
    constraintEffect: null,
    statement: "Run the narrowest test that proves the change.",
    ...overrides,
  };
}

describe("compileSteering", () => {
  it("answers null when nothing steers, so a workspace without records gets the bundle it had before", () => {
    expect(compileSteering([])).toBeNull();
    expect(
      compileSteering([
        rec({ force: "may" }),
        rec({ force: "info" }),
        rec({ force: null }),
        rec({ statement: null }),
        rec({ statement: "   " }),
      ]),
    ).toBeNull();
  });

  it("prints MUST before SHOULD, each sorted by slug, whatever order the rows arrive in", () => {
    const rows = [
      rec({ slug: "b-should", force: "should", statement: "Prefer B." }),
      rec({ slug: "z-must", statement: "Always Z." }),
      rec({
        slug: "a-must",
        kind: "constraint",
        constraintEffect: "forbid",
        statement: "Never A.",
      }),
      rec({ slug: "a-should", force: "should", statement: "Prefer A." }),
    ];
    const text = compileSteering(rows)!;
    expect(text.split("\n").slice(1)).toEqual([
      "",
      "MUST",
      "- Never A. (constraint, forbid; a-must)",
      "- Always Z. (rule; z-must)",
      "",
      "SHOULD",
      "- Prefer A. (rule; a-should)",
      "- Prefer B. (rule; b-should)",
    ]);
    expect(compileSteering([...rows].reverse())).toBe(text);
  });

  it("leaves out whole records past the limit, SHOULD first, and says how many", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      rec({
        slug: `r-${String(i).padStart(2, "0")}`,
        force: i < 5 ? "must" : "should",
        statement: `Statement ${i} ${"x".repeat(80)}.`,
      }),
    );
    const text = compileSteering(rows, 1_000)!;
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).toContain("(rule; r-00)");
    expect(text).toContain("(rule; r-04)");
    const kept = text.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(text).toMatch(new RegExp(`${40 - kept} more records were left out`));
    expect(text).not.toContain("r-39");
  });

  it("names a single omitted record in the singular", () => {
    const rows = [
      rec({ slug: "a", statement: "x".repeat(300) }),
      rec({ slug: "b", statement: "y".repeat(300) }),
    ];
    const text = compileSteering(rows, 600)!;
    expect(text).toContain("1 more record was left out");
    expect(text.length).toBeLessThanOrEqual(600);
  });

  it("stays inside the host's limit at the default", () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      rec({ slug: `r-${i}`, statement: "s".repeat(200) }),
    );
    expect(compileSteering(rows)!.length).toBeLessThanOrEqual(
      CONTEXT_SYSTEM_MAX_CHARS,
    );
  });
});

/**
 * A fake of the two statements the read issues, dispatched on the table the
 * statement is `from`: the count over `context_promotions` answers the cache
 * key from what the fake holds, and the join over `context_records` answers
 * the rows. Both count how often they ran.
 */
function fakeTx(db: { ledger: number; rows: SteeringRow[] }) {
  const calls = { version: 0, records: 0 };
  const tx: SteeringTx = {
    select: () => ({
      from: (table) => ({
        where: async () => {
          expect(tableName(table)).toBe("context_promotions");
          calls.version += 1;
          const steering = db.rows.filter((r) =>
            ["must", "should"].includes(r.versionForce ?? r.recordForce ?? ""),
          ).length;
          // Postgres answers count(*) as a bigint, which pg hands over as a
          // string; the read must coerce it.
          return [{ ledger: String(db.ledger), steering: String(steering) }];
        },
        leftJoin: () => ({
          where: async () => {
            expect(tableName(table)).toBe("context_records");
            calls.records += 1;
            return db.rows;
          },
        }),
      }),
    }),
  };
  return { tx, calls };
}

function tableName(table: unknown): string {
  for (const symbol of Object.getOwnPropertySymbols(table as object)) {
    if (symbol.description === "drizzle:Name")
      return (table as Record<symbol, string>)[symbol] ?? "?";
  }
  return "?";
}

function row(overrides: Partial<SteeringRow>): SteeringRow {
  return {
    slug: "a-record",
    versionKind: "rule",
    versionForce: "must",
    versionConstraintEffect: null,
    versionStatement: "Ask before deleting data.",
    recordKind: "rule",
    recordForce: "must",
    recordConstraintEffect: null,
    recordStatement: "Ask before deleting data.",
    ...overrides,
  };
}

describe("classificationOf", () => {
  it("reads the pinned version, not the record row's copy", () => {
    expect(
      classificationOf(
        row({
          versionKind: "rule",
          versionForce: "should",
          versionConstraintEffect: null,
          versionStatement: "Prefer small pull requests.",
          recordKind: "constraint",
          recordForce: "must",
          recordConstraintEffect: "forbid",
          recordStatement: "Never force-push.",
        }),
      ),
    ).toEqual({
      slug: "a-record",
      kind: "rule",
      force: "should",
      constraintEffect: null,
      statement: "Prefer small pull requests.",
    });
  });

  it("falls back to the record row only for a version with no classification", () => {
    expect(
      classificationOf(
        row({
          versionKind: null,
          versionForce: null,
          versionConstraintEffect: null,
          versionStatement: null,
          recordKind: "constraint",
          recordForce: "must",
          recordConstraintEffect: "forbid",
          recordStatement: "Never force-push.",
        }),
      ),
    ).toEqual({
      slug: "a-record",
      kind: "constraint",
      force: "must",
      constraintEffect: "forbid",
      statement: "Never force-push.",
    });
  });
});

describe("readWorkspaceSteering", () => {
  beforeEach(() => {
    clearSteeringCacheForTests();
  });

  it("compiles what the pinned versions say", async () => {
    const { tx, calls } = fakeTx({
      ledger: 1,
      rows: [
        row({
          versionStatement: "Ask before deleting data.",
          recordStatement: "A stale copy the row kept from a newer version.",
        }),
      ],
    });
    const text = await readWorkspaceSteering(tx, "org", "ws");
    expect(text).toContain("- Ask before deleting data. (rule; a-record)");
    expect(text).not.toContain("stale copy");
    expect(calls).toEqual({ version: 1, records: 1 });
  });

  it("answers from the cache while the steering version holds, and rereads once it moves", async () => {
    const db = { ledger: 1, rows: [row({})] };
    const { tx, calls } = fakeTx(db);
    const first = await readWorkspaceSteering(tx, "org", "ws");
    const again = await readWorkspaceSteering(tx, "org", "ws");
    expect(again).toBe(first);
    // Two cheap counts, one records read.
    expect(calls).toEqual({ version: 2, records: 1 });

    // A merge: one more ledger row, one more steering record.
    db.ledger = 2;
    db.rows = [
      ...db.rows,
      row({
        slug: "b-record",
        versionForce: "should",
        versionStatement: "Prefer small pull requests.",
      }),
    ];
    const moved = await readWorkspaceSteering(tx, "org", "ws");
    expect(moved).toContain("Prefer small pull requests.");
    expect(calls).toEqual({ version: 3, records: 2 });
  });

  it("rereads after a soft delete, which appends no ledger row", async () => {
    const db = { ledger: 2, rows: [row({}), row({ slug: "b-record" })] };
    const { tx, calls } = fakeTx(db);
    const before = await readWorkspaceSteering(tx, "org", "ws");
    expect(before).toContain("b-record");
    db.rows = [row({})];
    const after = await readWorkspaceSteering(tx, "org", "ws");
    expect(after).not.toContain("b-record");
    expect(calls).toEqual({ version: 2, records: 2 });
  });

  it("keeps one entry per workspace", async () => {
    const a = fakeTx({ ledger: 1, rows: [row({ versionStatement: "A." })] });
    const b = fakeTx({ ledger: 1, rows: [row({ versionStatement: "B." })] });
    expect(await readWorkspaceSteering(a.tx, "org", "ws-a")).toContain("A.");
    expect(await readWorkspaceSteering(b.tx, "org", "ws-b")).toContain("B.");
    expect(await readWorkspaceSteering(a.tx, "org", "ws-a")).toContain("A.");
    expect(a.calls).toEqual({ version: 2, records: 1 });
    expect(b.calls).toEqual({ version: 1, records: 1 });
  });

  it("caches a workspace with nothing to say, too", async () => {
    const { tx, calls } = fakeTx({ ledger: 0, rows: [] });
    expect(await readWorkspaceSteering(tx, "org", "ws")).toBeNull();
    expect(await readWorkspaceSteering(tx, "org", "ws")).toBeNull();
    expect(calls).toEqual({ version: 2, records: 1 });
  });

  it("drops the oldest workspace past the cap", async () => {
    for (let i = 0; i < STEERING_CACHE_MAX_ENTRIES; i++) {
      const { tx } = fakeTx({ ledger: 1, rows: [row({})] });
      await readWorkspaceSteering(tx, "org", `ws-${i}`);
    }
    const first = fakeTx({ ledger: 1, rows: [row({})] });
    await readWorkspaceSteering(first.tx, "org", "ws-0");
    expect(first.calls.records).toBe(0);
    // One workspace past the cap. A hit does not reorder, so ws-0 is still
    // the oldest entry and the one the cap drops.
    const extra = fakeTx({ ledger: 1, rows: [row({})] });
    await readWorkspaceSteering(extra.tx, "org", "ws-extra");
    await readWorkspaceSteering(first.tx, "org", "ws-0");
    expect(first.calls.records).toBe(1);
  });

  it("forgets everything on clearSteeringCacheForTests", async () => {
    const { tx, calls } = fakeTx({ ledger: 1, rows: [row({})] });
    await readWorkspaceSteering(tx, "org", "ws");
    clearSteeringCacheForTests();
    await readWorkspaceSteering(tx, "org", "ws");
    expect(calls).toEqual({ version: 2, records: 2 });
  });
});

describe("the bundle", () => {
  const host = {
    publicId: "tch_0123456789abcdefghjkmn",
    status: "active",
    mode: "observe",
    bundleVersionServed: 1,
    bundleFeatures: [],
  } as unknown as Parameters<typeof unsignedBundle>[0];
  const retention = { mode: "digest_only" as const, classes: [] };

  it("carries the compiled text in context.system, parses on the host, and moves the etag", () => {
    const system = compileSteering([rec({})]);
    const steered = unsignedBundle(
      host,
      { org: 0, workspace: 0 },
      retention,
      system,
    );
    const plain = unsignedBundle(
      host,
      { org: 0, workspace: 0 },
      retention,
      null,
    );
    expect(steered.context.system).toBe(system);
    expect(plain.context.system).toBeNull();
    expect(steered.etag).not.toBe(plain.etag);
    const sig = { key_id: "k", alg: "ed25519" as const, sig: "s" };
    expect(
      policyBundleSchema.safeParse({ ...steered, signature: sig }).success,
    ).toBe(true);
  });
});
