/**
 * The workspace's steering records, compiled into the bundle's
 * `context.system` (ADR-091). The text is part of the bundle etag, so it has
 * to be deterministic, and the host rejects the whole bundle past 16,384
 * characters, so it has to stay under that.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetColumnProbesForTests, runOnPlane } from "@oxagen/database";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
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

  it("delivers a record published through publish_context_record, now that the handler requires a classification (#3302)", () => {
    // Before #3302, publish_context_record wrote only the body: kind, force
    // and statement were all NULL, `rec({ force: null })` above is exactly
    // that row, and compileSteering excludes it. The contract now requires
    // kind, force and statement on every call, so the handler's write can
    // only ever produce a row shaped like this one — and this one steers.
    const published = rec({
      slug: "no-bare-unwrap",
      kind: "rule",
      force: "must",
      statement:
        "Never unwrap a Result on runtime data without handling the error.",
    });
    const text = compileSteering([published]);
    expect(text).not.toBeNull();
    expect(text).toContain("no-bare-unwrap");
    expect(text).toContain(published.statement);
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
function fakeTx(db: {
  ledger: number;
  rows: SteeringRow[];
  revisions?: string;
  /** Whether migration `20260918160000` has been applied on this database. */
  columns?: boolean;
}) {
  const calls = { version: 0, records: 0 };
  const probes = { count: 0 };
  const ready = db.columns !== false;
  const steeringCount = () =>
    db.rows.filter((r) =>
      ["must", "should"].includes(
        (ready ? r.versionForce : null) ?? r.recordForce ?? "",
      ),
    ).length;
  // Before the migration the read may not name the version columns, so the
  // rows it gets back carry the record copy only -- the shape Postgres would
  // hand it.
  const rowsAsRead = (): SteeringRow[] =>
    ready
      ? db.rows
      : db.rows.map(
          ({
            versionKind: _k,
            versionForce: _f,
            versionConstraintEffect: _c,
            versionStatement: _s,
            ...rest
          }) => rest,
        );
  const versionRow = async () => {
    calls.version += 1;
    // Postgres answers count(*) as a bigint, which pg hands over as a
    // string; the read must coerce it.
    return [
      {
        ledger: String(db.ledger),
        steering: String(steeringCount()),
        revisions: db.revisions ?? "initial-revision",
      },
    ];
  };
  const recordRows = async () => {
    calls.records += 1;
    return rowsAsRead();
  };
  const tx: SteeringTx = {
    // The column probe. `hasColumn` reads presence from the row count, so an
    // empty array is "the migration has not run".
    execute: () => {
      probes.count += 1;
      return ready ? [{ "?column?": 1 }] : [];
    },
    select: (fields) => {
      if ("ledger" in fields) {
        expect(fields.revisions).toBeInstanceOf(SQL);
        const query = new PgDialect().sqlToQuery(fields.revisions as SQL);
        expect(query.sql).toContain("md5(string_agg(md5(");
        expect(query.sql).toContain('"context_records"."active_version_id"');
        expect(query.sql).toContain('"context_records"."statement"');
        expect(query.sql).toContain('order by "context_records"."id"');
        expect(query.params).toContain("org");
        expect(query.params).toContain("active");
        if (!ready) {
          expect(query.sql).not.toContain('"context_record_versions"');
        }
      }
      return {
        from: (table) => ({
          where: async () => {
            // Two statements land here. The count is `from context_promotions`;
            // the record-only read, which has no join to make, is
            // `from context_records`.
            if (tableName(table) === "context_promotions") return versionRow();
            expect(tableName(table)).toBe("context_records");
            expect(ready).toBe(false);
            return recordRows();
          },
          leftJoin: () => ({
            where: async () => {
              expect(tableName(table)).toBe("context_records");
              expect(ready).toBe(true);
              return recordRows();
            },
          }),
        }),
      };
    },
  };
  return { tx, calls, probes };
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
    // The column probe answers once per process per plane, so a test that
    // runs on a database without the columns would otherwise decide it for
    // every test after it.
    resetColumnProbesForTests();
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

  it.each([true, false])(
    "rereads a direct republish with unchanged ledger and count (version columns: %s)",
    async (columns) => {
      const db = {
        columns,
        ledger: 1,
        revisions: "version-1",
        rows: [row({})],
      };
      const { tx, calls } = fakeTx(db);
      const before = await readWorkspaceSteering(tx, "org", "ws");
      expect(before).toContain("Ask before deleting data.");
      // publish_context_record changes the pin and classification together.
      // It appends no promotion, and the active record count stays at one.
      db.revisions = "version-2";
      db.rows = [
        row({
          versionKind: "constraint",
          versionConstraintEffect: "forbid",
          versionStatement: "Do not delete production data.",
          recordKind: "constraint",
          recordConstraintEffect: "forbid",
          recordStatement: "Do not delete production data.",
        }),
      ];
      const after = await readWorkspaceSteering(tx, "org", "ws");
      expect(after).toContain(
        "Do not delete production data. (constraint, forbid;",
      );
      expect(after).not.toContain("Ask before deleting data.");
      expect(await readWorkspaceSteering(tx, "org", "ws")).toBe(after);
      expect(calls).toEqual({ version: 3, records: 2 });
    },
  );

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

  // `set_data_plane` moves an organisation between physical databases. A
  // workspace's identity does not name the one it is on, so two planes that
  // agree on migration state, ledger length and steering-record count produce
  // the same key -- and the first read after the move would answer from text
  // compiled against the database the organisation just left.
  it("does not serve one plane's text on another", async () => {
    const before = fakeTx({
      ledger: 1,
      rows: [row({ versionStatement: "What the old plane says." })],
    });
    const after = fakeTx({
      ledger: 1,
      rows: [row({ versionStatement: "What the new plane says." })],
    });

    expect(
      await runOnPlane("plane-a", () =>
        readWorkspaceSteering(before.tx, "org", "ws"),
      ),
    ).toContain("What the old plane says.");
    expect(
      await runOnPlane("plane-b", () =>
        readWorkspaceSteering(after.tx, "org", "ws"),
      ),
    ).toContain("What the new plane says.");
    // The second plane read its own rows rather than taking the first's entry.
    expect(after.calls).toEqual({ version: 1, records: 1 });
  });

  it("keeps caching within one plane", async () => {
    const { tx, calls } = fakeTx({ ledger: 1, rows: [row({})] });
    await runOnPlane("plane-a", () => readWorkspaceSteering(tx, "org", "ws"));
    await runOnPlane("plane-a", () => readWorkspaceSteering(tx, "org", "ws"));
    expect(calls).toEqual({ version: 2, records: 1 });
  });

  // Production applies migrations by hand while `deploy-node` ships on merge,
  // so this code is live on a database without the version columns for as long
  // as that window lasts. Naming one then raises 42703 and aborts the
  // transaction -- which is every bundle fetch, control poll, event ingest and
  // enrollment in the workspace, none of them about a classification.
  describe("while migration 20260918160000 is pending", () => {
    it("compiles from the record row and never names a version column", async () => {
      const { tx, calls } = fakeTx({
        columns: false,
        ledger: 1,
        rows: [
          row({
            versionStatement: "What the pinned version says.",
            recordStatement: "What the record row says.",
          }),
        ],
      });
      // fakeTx asserts the read took the un-joined path; the text proves it
      // used the only classification such a database can hold.
      const text = await readWorkspaceSteering(tx, "org", "ws");
      expect(text).toContain("What the record row says.");
      expect(text).not.toContain("What the pinned version says.");
      expect(calls).toEqual({ version: 1, records: 1 });
    });

    it("counts a row that steers by its record force alone", async () => {
      const { tx } = fakeTx({
        columns: false,
        ledger: 1,
        rows: [row({ versionForce: "info", recordForce: "must" })],
      });
      expect(await readWorkspaceSteering(tx, "org", "ws")).not.toBeNull();
    });

    it("probes once per call and caches the compiled text as usual", async () => {
      const { tx, calls, probes } = fakeTx({
        columns: false,
        ledger: 1,
        rows: [row({})],
      });
      await readWorkspaceSteering(tx, "org", "ws");
      await readWorkspaceSteering(tx, "org", "ws");
      // One probe: `hasColumn` holds a negative answer for its TTL, which is
      // far longer than this test.
      expect(probes.count).toBe(1);
      expect(calls).toEqual({ version: 2, records: 1 });
    });

    it("drops the text compiled without the columns once they land", async () => {
      const pending = fakeTx({
        columns: false,
        ledger: 1,
        rows: [
          row({
            versionStatement: "What the pinned version says.",
            recordStatement: "What the record row says.",
          }),
        ],
      });
      expect(await readWorkspaceSteering(pending.tx, "org", "ws")).toContain(
        "What the record row says.",
      );

      // The migration lands. Neither the ledger nor the record count moves, so
      // only the probe's answer in the cache key can invalidate the entry.
      resetColumnProbesForTests();
      const migrated = fakeTx({
        ledger: 1,
        rows: [
          row({
            versionStatement: "What the pinned version says.",
            recordStatement: "What the record row says.",
          }),
        ],
      });
      expect(await readWorkspaceSteering(migrated.tx, "org", "ws")).toContain(
        "What the pinned version says.",
      );
      expect(migrated.calls).toEqual({ version: 1, records: 1 });
    });
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
