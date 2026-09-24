/**
 * The workspace's steering records, assembled into the bundle's
 * `context.system` and `context.manifest` (ADR-091, ADR-093). The text is
 * part of the bundle etag, so it has to be deterministic, and the host
 * rejects the whole bundle past 16,384 characters, so it has to stay under
 * that.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetColumnProbesForTests, runOnPlane } from "@oxagen/database";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { policyBundleSchema } from "@oxagen/oxagen/tacho/schemas";
import { steeringManifestSchema } from "@oxagen/tacho";
import {
  SMALLEST_HARNESS_CONTEXT_MAX_CHARS,
  STEERING_HEADER,
} from "@oxagen/steering-assembler";
import {
  CONTEXT_SYSTEM_BUDGET_TOKENS,
  CONTEXT_SYSTEM_MAX_CHARS,
  STEERING_CACHE_MAX_ENTRIES,
  assembleWorkspaceSteering,
  classificationOf,
  clearSteeringCacheForTests,
  readWorkspaceSteering,
  recordCandidate,
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
    activatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

const assemble = (records: SteeringRecord[], budget?: number) =>
  assembleWorkspaceSteering("org", "ws", records, budget);

describe("recordCandidate", () => {
  it("renders the line ADR-091 rendered, and reads the activation instant", () => {
    expect(
      recordCandidate(
        rec({
          slug: "a-must",
          kind: "constraint",
          constraintEffect: "forbid",
          statement: "Never A.",
          activatedAt: new Date("2026-09-11T00:00:00.000Z"),
        }),
      ),
    ).toEqual({
      id: "a-must",
      kind: "record",
      force: "must",
      body: "Never A. (constraint, forbid; a-must)",
      recordedAt: "2026-09-11T00:00:00.000Z",
    });
    expect(recordCandidate(rec({ kind: null, activatedAt: null }))).toEqual({
      id: "a-record",
      kind: "record",
      force: "must",
      body: "Run the narrowest test that proves the change. (record; a-record)",
      recordedAt: "",
    });
  });

  it("answers null for a row that cannot steer", () => {
    expect(recordCandidate(rec({ force: null }))).toBeNull();
    expect(recordCandidate(rec({ force: "urgent" }))).toBeNull();
    expect(recordCandidate(rec({ statement: null }))).toBeNull();
    expect(recordCandidate(rec({ statement: "   " }))).toBeNull();
  });
});

describe("assembleWorkspaceSteering", () => {
  it("answers null text when nothing steers, so a workspace without records gets the bundle it had before", () => {
    const empty = assemble([]);
    expect(empty.text).toBeNull();
    expect(empty.manifest).toMatchObject({ included: 0, cut: 0, items: [] });
    // Rows that cannot steer are not candidates; may and info are, and the
    // manifest says they were cut for their tier.
    const quiet = assemble([
      rec({ slug: "m", force: "may" }),
      rec({ slug: "i", force: "info" }),
      rec({ force: null }),
      rec({ statement: null }),
      rec({ statement: "   " }),
    ]);
    expect(quiet.text).toBeNull();
    expect(quiet.manifest.items).toEqual([
      expect.objectContaining({ id: "m", outcome: "cut", reason: "tier" }),
      expect.objectContaining({ id: "i", outcome: "cut", reason: "tier" }),
    ]);
  });

  it("delivers a record published through publish_context_record, now that the handler requires a classification (#3302)", () => {
    const published = rec({
      slug: "no-bare-unwrap",
      kind: "rule",
      force: "must",
      statement:
        "Never unwrap a Result on runtime data without handling the error.",
    });
    const { text, manifest } = assemble([published]);
    expect(text).toContain("no-bare-unwrap");
    expect(text).toContain(published.statement);
    expect(manifest.items).toEqual([
      expect.objectContaining({ id: "no-bare-unwrap", outcome: "included" }),
    ]);
  });

  it("prints MUST before SHOULD, newest first within a tier, whatever order the rows arrive in", () => {
    const rows = [
      rec({
        slug: "b-should",
        force: "should",
        statement: "Prefer B.",
        activatedAt: "2026-09-01T00:00:00Z",
      }),
      rec({
        slug: "z-must",
        statement: "Always Z.",
        activatedAt: "2026-09-03T00:00:00Z",
      }),
      rec({
        slug: "a-must",
        kind: "constraint",
        constraintEffect: "forbid",
        statement: "Never A.",
        activatedAt: "2026-09-02T00:00:00Z",
      }),
      rec({
        slug: "a-should",
        force: "should",
        statement: "Prefer A.",
        activatedAt: "2026-09-01T00:00:00Z",
      }),
    ];
    const { text } = assemble(rows);
    expect(text!.split("\n")).toEqual([
      STEERING_HEADER,
      "",
      "MUST",
      "- Always Z. (rule; z-must)",
      "- Never A. (constraint, forbid; a-must)",
      "",
      "SHOULD",
      "- Prefer A. (rule; a-should)",
      "- Prefer B. (rule; b-should)",
    ]);
    expect(assemble([...rows].reverse())).toEqual(assemble(rows));
  });

  it("names budget as the reason for every cut when a workspace holds more must records than the budget, and includes the same set twice", () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      rec({
        slug: `r-${String(i).padStart(2, "0")}`,
        statement: `Statement ${i} ${"x".repeat(80)}.`,
        activatedAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const first = assemble(rows, 250);
    const second = assemble([...rows].reverse(), 250);
    expect(first.text!.length).toBeLessThanOrEqual(1_000);
    expect(first.manifest.included).toBeGreaterThan(0);
    expect(first.manifest.cut).toBeGreaterThan(0);
    for (const item of first.manifest.items) {
      if (item.outcome === "cut") expect(item.reason).toBe("budget");
    }
    expect(first.text).toMatch(
      new RegExp(`${first.manifest.cut} more records were left out`),
    );
    expect(second).toEqual(first);
  });

  it("names a single omitted record in the singular", () => {
    const rows = [
      rec({ slug: "a", statement: "x".repeat(300) }),
      rec({ slug: "b", statement: "y".repeat(300) }),
    ];
    const { text } = assemble(rows, 150);
    expect(text).toContain("1 more record was left out");
    expect(text!.length).toBeLessThanOrEqual(600);
  });

  // Witness for #3944: at 4,096 tokens the text reached 16,384 characters,
  // and Claude Code swaps anything past 10,000 for a file path.
  it("stays inside the smallest harness limit at the default budget", () => {
    const rows = Array.from({ length: 500 }, (_, i) =>
      rec({ slug: `r-${i}`, statement: "s".repeat(200) }),
    );
    const { text, manifest } = assemble(rows);
    expect(text!.length).toBeLessThanOrEqual(CONTEXT_SYSTEM_MAX_CHARS);
    expect(text!.length).toBeLessThanOrEqual(
      SMALLEST_HARNESS_CONTEXT_MAX_CHARS,
    );
    expect(manifest.budget_tokens).toBe(CONTEXT_SYSTEM_BUDGET_TOKENS);
    expect(manifest.spent_tokens).toBeLessThanOrEqual(
      CONTEXT_SYSTEM_BUDGET_TOKENS,
    );
  });

  // The leaf package carries its own copy of the manifest shape (H7), and
  // this is what keeps the two in step: the assembler's output must parse
  // under the schema the host seals it with.
  it("produces a manifest the host's wire schema accepts", () => {
    const { manifest } = assemble(
      [
        rec({ slug: "a" }),
        rec({ slug: "b", force: "may" }),
        rec({ slug: "c", statement: "z".repeat(5_000) }),
      ],
      300,
    );
    expect(steeringManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.items.map((i) => i.reason ?? null)).toEqual([
      null,
      "budget",
      "tier",
    ]);
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
      ["must", "should", "may", "info"].includes(
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
        expect(query.sql).toContain('order by "agent"."context_records"."id"');
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
    activatedAt: new Date("2026-09-10T00:00:00.000Z"),
    createdAt: new Date("2026-09-09T00:00:00.000Z"),
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
      activatedAt: new Date("2026-09-10T00:00:00.000Z"),
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
      activatedAt: new Date("2026-09-10T00:00:00.000Z"),
    });
  });

  it("takes the row's creation instant for a record that never activated", () => {
    expect(classificationOf(row({ activatedAt: null })).activatedAt).toEqual(
      new Date("2026-09-09T00:00:00.000Z"),
    );
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
    const { text } = await readWorkspaceSteering(tx, "org", "ws");
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
    expect(moved.text).toContain("Prefer small pull requests.");
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
      expect(before.text).toContain("Ask before deleting data.");
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
      expect(after.text).toContain(
        "Do not delete production data. (constraint, forbid;",
      );
      expect(after.text).not.toContain("Ask before deleting data.");
      expect(await readWorkspaceSteering(tx, "org", "ws")).toBe(after);
      expect(calls).toEqual({ version: 3, records: 2 });
    },
  );

  it("rereads after a soft delete, which appends no ledger row", async () => {
    const db = { ledger: 2, rows: [row({}), row({ slug: "b-record" })] };
    const { tx, calls } = fakeTx(db);
    const before = await readWorkspaceSteering(tx, "org", "ws");
    expect(before.text).toContain("b-record");
    db.rows = [row({})];
    const after = await readWorkspaceSteering(tx, "org", "ws");
    expect(after.text).not.toContain("b-record");
    expect(calls).toEqual({ version: 2, records: 2 });
  });

  it("keeps one entry per workspace", async () => {
    const a = fakeTx({ ledger: 1, rows: [row({ versionStatement: "A." })] });
    const b = fakeTx({ ledger: 1, rows: [row({ versionStatement: "B." })] });
    expect((await readWorkspaceSteering(a.tx, "org", "ws-a")).text).toContain(
      "A.",
    );
    expect((await readWorkspaceSteering(b.tx, "org", "ws-b")).text).toContain(
      "B.",
    );
    expect((await readWorkspaceSteering(a.tx, "org", "ws-a")).text).toContain(
      "A.",
    );
    expect(a.calls).toEqual({ version: 2, records: 1 });
    expect(b.calls).toEqual({ version: 1, records: 1 });
  });

  it("caches a workspace with nothing to say, too", async () => {
    const { tx, calls } = fakeTx({ ledger: 0, rows: [] });
    expect((await readWorkspaceSteering(tx, "org", "ws")).text).toBeNull();
    expect((await readWorkspaceSteering(tx, "org", "ws")).text).toBeNull();
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
      (
        await runOnPlane("plane-a", () =>
          readWorkspaceSteering(before.tx, "org", "ws"),
        )
      ).text,
    ).toContain("What the old plane says.");
    expect(
      (
        await runOnPlane("plane-b", () =>
          readWorkspaceSteering(after.tx, "org", "ws"),
        )
      ).text,
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
      const { text } = await readWorkspaceSteering(tx, "org", "ws");
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
      expect(
        (await readWorkspaceSteering(tx, "org", "ws")).text,
      ).not.toBeNull();
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
      expect(
        (await readWorkspaceSteering(pending.tx, "org", "ws")).text,
      ).toContain("What the record row says.");

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
      expect(
        (await readWorkspaceSteering(migrated.tx, "org", "ws")).text,
      ).toContain("What the pinned version says.");
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
  const noMandate = {
    permissions: { allow: [], deny: [], ask: [] },
    budget: { mode: "observed" as const },
  };

  it("carries the assembled text in context.system, parses on the host, and moves the etag", () => {
    const steering = assemble([rec({})]);
    const steered = unsignedBundle(
      host,
      { org: 0, workspace: 0 },
      retention,
      steering,
      noMandate,
    );
    const plain = unsignedBundle(
      host,
      { org: 0, workspace: 0 },
      retention,
      assemble([]),
      noMandate,
    );
    expect(steered.context.system).toBe(steering.text);
    expect(plain.context.system).toBeNull();
    expect(steered.etag).not.toBe(plain.etag);
    const sig = { key_id: "k", alg: "ed25519" as const, sig: "s" };
    expect(
      policyBundleSchema.safeParse({ ...steered, signature: sig }).success,
    ).toBe(true);
  });
});
