/**
 * The published-record read both steering surfaces share: the policy bundle
 * (`packages/handlers/src/lib/tacho-steering.ts`) and the in-app assistant's
 * turn (`assistant-steering.ts`). The bundle's cache and budget are tested
 * beside the bundle; this file covers the read and the adapter.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resetColumnProbesForTests, runOnPlane } from "@oxagen/database";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  classificationOf,
  readPublishedSteeringCandidates,
  readSteeringRows,
  readSteeringVersion,
  recordCandidate,
  type SteeringRecord,
  type SteeringRow,
  type SteeringTx,
  versionClassificationReady,
} from "./published-steering";

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

/**
 * A fake of the statements the read issues, dispatched on the table each is
 * `from`. `columns: false` is a database migration `20260918160000` has not
 * reached: the probe answers no rows and the read must not name a version
 * column.
 */
function fakeTx(db: {
  rows: SteeringRow[];
  version?: Record<string, unknown>[];
  columns?: boolean;
}) {
  const ready = db.columns !== false;
  const seen: { joined: boolean | null; selected: string[] } = {
    joined: null,
    selected: [],
  };
  const asRead = (): SteeringRow[] =>
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
  const tx: SteeringTx = {
    execute: () => (ready ? [{ "?column?": 1 }] : []),
    select: (fields) => {
      seen.selected = Object.keys(fields);
      return {
        from: (table) => ({
          where: async () => {
            if (tableName(table) === "context_promotions")
              return db.version ?? [];
            expect(tableName(table)).toBe("context_records");
            seen.joined = false;
            return asRead();
          },
          leftJoin: (joined) => ({
            where: async () => {
              expect(tableName(table)).toBe("context_records");
              expect(tableName(joined)).toBe("context_record_versions");
              seen.joined = true;
              return asRead();
            },
          }),
        }),
      };
    },
  };
  return { tx, seen };
}

beforeEach(() => {
  // The probe answers once per process per plane; a test on a database
  // without the columns would otherwise decide it for every test after it.
  resetColumnProbesForTests();
});

describe("recordCandidate", () => {
  const rec = (overrides: Partial<SteeringRecord>): SteeringRecord => ({
    slug: "a-record",
    kind: "rule",
    force: "must",
    constraintEffect: null,
    statement: "Run the narrowest test that proves the change.",
    activatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  });

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
    expect(recordCandidate(rec({ kind: null, activatedAt: null }))).toEqual(
      expect.objectContaining({
        body: "Run the narrowest test that proves the change. (record; a-record)",
        recordedAt: "",
      }),
    );
  });

  it("answers null for a row that cannot steer (negative)", () => {
    expect(recordCandidate(rec({ force: null }))).toBeNull();
    expect(recordCandidate(rec({ force: "sometimes" }))).toBeNull();
    expect(recordCandidate(rec({ statement: null }))).toBeNull();
    expect(recordCandidate(rec({ statement: "   " }))).toBeNull();
  });
});

describe("classificationOf", () => {
  it("reads the pinned version, and the record row only for a version with no classification", () => {
    expect(
      classificationOf(
        row({ versionForce: "should", recordStatement: "A stale copy." }),
      ),
    ).toEqual(
      expect.objectContaining({
        force: "should",
        statement: "Ask before deleting data.",
      }),
    );
    expect(
      classificationOf(
        row({
          versionKind: null,
          versionForce: null,
          versionStatement: null,
          recordKind: "constraint",
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
    expect(classificationOf(row({ activatedAt: null })).activatedAt).toEqual(
      new Date("2026-09-09T00:00:00.000Z"),
    );
  });
});

describe("readSteeringVersion", () => {
  it("names the ledger length, the steering count and the revision digest", async () => {
    const { tx } = fakeTx({
      rows: [],
      // Postgres answers count(*) as a bigint, which pg hands over as a
      // string; the read coerces it.
      version: [{ ledger: "3", steering: "2", revisions: "abc" }],
    });
    expect(await readSteeringVersion(tx, "org", "ws", true)).toBe("3:2:abc");
  });

  it("answers an empty workspace's key when no row comes back", async () => {
    const { tx } = fakeTx({ rows: [] });
    expect(await readSteeringVersion(tx, "org", "ws", false)).toBe("0:0:");
  });

  it("qualifies every column and joins the pinned version only once it exists", async () => {
    const captured: SQL[] = [];
    const tx = {
      execute: () => [],
      select: (fields: Record<string, unknown>) => {
        captured.push(fields.revisions as SQL);
        return {
          from: () => ({ where: async () => [] }),
        };
      },
    } as unknown as SteeringTx;
    await readSteeringVersion(tx, "org", "ws", true);
    await readSteeringVersion(tx, "org", "ws", false);
    const [ready, pending] = captured.map(
      (fragment) => new PgDialect().sqlToQuery(fragment).sql,
    );
    expect(ready).toContain('"context_record_versions"');
    expect(ready).toContain('order by "agent"."context_records"."id"');
    expect(pending).not.toContain('"context_record_versions"');
  });
});

describe("readSteeringRows", () => {
  it("joins the pinned version once the columns exist", async () => {
    const { tx, seen } = fakeTx({ rows: [row({})] });
    expect(await readSteeringRows(tx, "org", "ws", true)).toEqual([row({})]);
    expect(seen.joined).toBe(true);
    expect(seen.selected).toContain("versionStatement");
  });

  it("reads the record row alone while the migration is pending, and names no version column", async () => {
    const { tx, seen } = fakeTx({ rows: [row({})], columns: false });
    const rows = await readSteeringRows(tx, "org", "ws", false);
    expect(seen.joined).toBe(false);
    expect(seen.selected).not.toContain("versionStatement");
    expect(rows[0]).not.toHaveProperty("versionStatement");
  });
});

describe("readPublishedSteeringCandidates", () => {
  it("answers every record that can steer as a candidate, and leaves out one that cannot", async () => {
    const { tx } = fakeTx({
      rows: [
        row({ slug: "a-must", versionStatement: "Ask first." }),
        row({ slug: "b-info", versionForce: "info", versionStatement: "B." }),
        row({ slug: "c-empty", versionStatement: "  " }),
      ],
    });
    expect(await readPublishedSteeringCandidates(tx, "org", "ws")).toEqual([
      {
        id: "a-must",
        kind: "record",
        force: "must",
        body: "Ask first. (rule; a-must)",
        recordedAt: "2026-09-10T00:00:00.000Z",
      },
      {
        id: "b-info",
        kind: "record",
        force: "info",
        body: "B. (rule; b-info)",
        recordedAt: "2026-09-10T00:00:00.000Z",
      },
    ]);
  });

  it("reads the record row's copy on a plane the migration has not reached", async () => {
    const { tx, seen } = fakeTx({
      rows: [
        row({
          versionStatement: "What the version says.",
          recordStatement: "What the row says.",
        }),
      ],
      columns: false,
    });
    const candidates = await runOnPlane("dedicated", () =>
      readPublishedSteeringCandidates(tx, "org", "ws"),
    );
    expect(candidates.map((c) => c.body)).toEqual([
      "What the row says. (rule; a-record)",
    ]);
    expect(seen.joined).toBe(false);
    expect(await versionClassificationReady(tx, "dedicated")).toBe(false);
  });
});
