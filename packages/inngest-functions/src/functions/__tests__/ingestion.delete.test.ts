import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  // scopedSession: returns records for alias promotion + deletion pass
  scopedSessionRun: vi.fn(),
  scopedSessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
  insertEvents: vi.fn().mockResolvedValue(undefined),
}));

type HandlerCtx = {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
  };
};
let capturedHandler: ((ctx: HandlerCtx) => unknown) | null = null;
// The create-function adapter registers the on-failure companion as a SECOND
// inngest.createFunction call with id `${config.id}.on-failure` (onFailure is
// stripped from the inngest config) — route captures by id so the companion
// registration doesn't clobber the primary handler.
let capturedOnFailure: ((ctx: HandlerCtx) => unknown) | null = null;

// The create-function adapter registers TWO Inngest functions when a config
// carries onFailure: the primary (id = config.id) and a companion whose id is
// `${config.id}.on-failure`, each passing its (wrapped) handler as the 3rd
// arg — buildInngestConfig never forwards `onFailure` itself. Route the capture
// by id; capturing `opts.onFailure` (the old shape) left capturedOnFailure null
// and let the companion registration overwrite capturedHandler.
mocks.createFunction.mockImplementation(
  (
    opts: { id?: string },
    _trigger: unknown,
    handler: typeof capturedHandler,
  ) => {
    if (typeof opts?.id === "string" && opts.id.endsWith(".on-failure")) {
      capturedOnFailure = handler;
    } else {
      capturedHandler = handler;
    }
    return {};
  },
);

vi.mock("../../inngest", () => ({
  inngest: { createFunction: mocks.createFunction },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  ),
}));

vi.mock("@oxagen/ontology", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/ontology")>();
  return {
    ...real,
    scopedSession: mocks.scopedSession,
  };
});

vi.mock("../../logger", () => ({
  logger: { info: mocks.loggerInfo, debug: vi.fn(), error: mocks.loggerError },
}));

// Spread the real module so transitive exports the @oxagen/ontology mock pulls
// in via importOriginal (e.g. isDirectRunEntry, imported by ontology's
// migrate.ts at module-load) stay defined; override only insertEvents.
vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    insertEvents: mocks.insertEvents,
  };
});

await import("../ingestion.delete");

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_EVENT = {
  connectionId: "conn-delete-1",
  deletionJobId: "djob-del-1",
  orgId: "org-del",
  workspaceId: "ws-del",
  requestedBy: "user-123",
  requestedAt: "2026-06-09T00:00:00Z",
};

function makeStep(): HandlerCtx["step"] {
  return {
    run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
  };
}

function setupTenantDb(mockExecute = vi.fn().mockResolvedValue([])): void {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ execute: mockExecute }),
  );
  mocks.runInTenantScope.mockImplementation(
    (_scope: unknown, fn: () => unknown) => fn(),
  );
}

function setupScopedSession(): void {
  // Default: every counter returns 0 — including Pass 5's `leftover`
  // probe, which is the assertion that nothing survived.
  mocks.scopedSessionRun.mockResolvedValue({
    records: [{ get: (_k: string) => 0 }],
  });
  mocks.scopedSession.mockReturnValue({
    run: mocks.scopedSessionRun,
    close: mocks.scopedSessionClose,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ingestion.delete-connection Inngest function", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupTenantDb();
    setupScopedSession();
  });

  describe("mode: connection_only", () => {
    it("runs mark-deleting and delete-postgres-records but NOT delete-neo4j-data", async () => {
      const step = makeStep();
      const stepRun = step.run as ReturnType<typeof vi.fn>;

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "connection_only" } },
        step,
      });

      const stepNames: string[] = stepRun.mock.calls.map((c) => c[0] as string);
      expect(stepNames).toContain("mark-deleting");
      expect(stepNames).toContain("delete-postgres-records");
      expect(stepNames).not.toContain("delete-neo4j-data");
    });

    it("returns connectionId, mode, and deletedAt", async () => {
      const step = makeStep();
      const result = await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "connection_only" } },
        step,
      });

      expect(result).toMatchObject({
        connectionId: "conn-delete-1",
        mode: "connection_only",
        deletedAt: expect.any(String),
      });
    });
  });

  describe("mode: data_only", () => {
    it("runs mark-deleting and delete-neo4j-data but NOT delete-postgres-records", async () => {
      const step = makeStep();

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "data_only" } },
        step,
      });

      const stepRun = step.run as ReturnType<typeof vi.fn>;
      const stepNames: string[] = stepRun.mock.calls.map((c) => c[0] as string);
      expect(stepNames).toContain("mark-deleting");
      expect(stepNames).toContain("delete-neo4j-data");
      expect(stepNames).not.toContain("delete-postgres-records");
    });

    it("calls scopedSession to delete Neo4j entity nodes", async () => {
      const step = makeStep();

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "data_only" } },
        step,
      });

      // scopedSession().run should have been called for alias promotion + deletion
      expect(mocks.scopedSessionRun).toHaveBeenCalled();
    });

    it("anchors the free endpoint of every two-endpoint alias match", async () => {
      // Anchoring one endpoint of a two-endpoint match leaves the other free.
      // `alias` is PROMOTED (its identity fields are overwritten) and `other`
      // has an edge MERGEd off it and its existing one DELETEd, so both are
      // written to and both must carry the principal's tenant. A legacy or BYO
      // graph can hold an ALIAS_OF from another organisation's node.
      const step = makeStep();

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "data_only" } },
        step,
      });

      const promotion = (
        mocks.scopedSessionRun.mock.calls as Array<[string, unknown]>
      )
        .map(([cypher]) => cypher)
        .find((cypher) => cypher.includes("MERGE (o)-[newEdge:ALIAS_OF]"));

      expect(promotion).toBeDefined();
      expect(promotion).toContain("alias.orgId = $orgId");
      expect(promotion).toContain("other.orgId = $orgId");
    });

    it("copies the alias edge wholesale rather than naming its properties", async () => {
      // A reroute moves an EXISTING edge; nothing about it is a new
      // observation. The first version of this copy enumerated nine properties
      // and called itself complete — and had already missed `updatedAt`, which
      // `createAliasEdge`'s ON MATCH branch stamps on every re-assertion, so
      // promoting an alias dropped the timestamp belonging to the confidence it
      // kept. An enumeration is only complete on the day it is written, so the
      // invariant asserted here is that there is NO enumeration: the map is
      // copied, and exactly one property is named, because it is a deliberate
      // legacy default rather than part of the copy.
      const step = makeStep();

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "data_only" } },
        step,
      });

      const promotion = (
        mocks.scopedSessionRun.mock.calls as Array<[string, unknown]>
      )
        .map(([cypher]) => cypher)
        .find((cypher) => cypher.includes("MERGE (o)-[newEdge:ALIAS_OF]"));

      expect(promotion).toBeDefined();
      expect(promotion).toContain("newEdge = properties(old)");

      // The only individually named property is the override.
      const named = [...promotion!.matchAll(/newEdge\.(\w+)\s*=/g)].map(
        (m) => m[1],
      );
      expect(named).toEqual(["is_system"]);
      expect(promotion).toContain(
        "newEdge.is_system = coalesce(old.is_system, true)",
      );

      // `is_system` is the marker that keeps schema reconciliation's prune off
      // platform-owned edges; an edge that lost it here would later be pruned
      // as user data (see NON_SYSTEM_RELATIONSHIP_FILTER in schema.reconcile).
      expect(promotion).toContain("DELETE old");
    });
  });

  describe("mode: full", () => {
    it("runs mark-deleting, delete-neo4j-data, AND delete-postgres-records", async () => {
      const step = makeStep();

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "full" } },
        step,
      });

      const stepRun = step.run as ReturnType<typeof vi.fn>;
      const stepNames: string[] = stepRun.mock.calls.map((c) => c[0] as string);
      expect(stepNames).toContain("mark-deleting");
      expect(stepNames).toContain("delete-neo4j-data");
      expect(stepNames).toContain("delete-postgres-records");
      expect(stepNames).toContain("audit-log");
    });

    it("returns connectionId, mode, and deletedAt", async () => {
      const step = makeStep();

      const result = await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "full" } },
        step,
      });

      expect(result).toMatchObject({
        connectionId: "conn-delete-1",
        mode: "full",
        deletedAt: expect.any(String),
      });
    });
  });

  describe("postgres deletion steps", () => {
    it("executes DELETE queries for mappings, suggestions, webhooks, creds, and soft-deletes connection", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      setupTenantDb(mockExecute);

      const step = makeStep();
      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "connection_only" } },
        step,
      });

      // At least 5 SQL statements: mark-deleting + 4 deletes + 1 update in delete-postgres-records
      expect(mockExecute.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("audit-log step — ClickHouse telemetry", () => {
    it("emits an ingestion.connection.deleted event with org/workspace/connection ids, mode, and requestedBy", async () => {
      const step = makeStep();
      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "full" } },
        step,
      });

      expect(mocks.insertEvents).toHaveBeenCalledTimes(1);
      const [rows] = mocks.insertEvents.mock.calls[0] as [
        Array<Record<string, unknown>>,
      ];
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error("expected one telemetry event row");
      expect(row).toMatchObject({
        org_id: "org-del",
        workspace_id: "ws-del",
        event_type: "ingestion.connection.deleted",
        source_system: "inngest:ingestion.delete-connection",
        stream_offset: null,
      });
      expect(typeof row.event_id).toBe("string");
      expect(typeof row.emitted_at).toBe("string");
      // Deletion detail travels in the JSON payload.
      const payload = JSON.parse(row.payload as string) as Record<
        string,
        unknown
      >;
      expect(payload).toEqual({
        connectionId: "conn-delete-1",
        mode: "full",
        requestedBy: "user-123",
        requestedAt: "2026-06-09T00:00:00Z",
      });
    });

    it("logs (does NOT throw) when the ClickHouse write fails, so deletion still succeeds", async () => {
      mocks.insertEvents.mockRejectedValueOnce(
        new Error("clickhouse unreachable"),
      );
      const step = makeStep();

      const result = await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "connection_only" } },
        step,
      });

      // Job completes normally despite the telemetry failure.
      expect(result).toMatchObject({
        connectionId: "conn-delete-1",
        mode: "connection_only",
        deletedAt: expect.any(String),
      });
      expect(mocks.loggerError).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: "conn-delete-1",
          mode: "connection_only",
        }),
        expect.stringContaining("ClickHouse audit event write failed"),
      );
    });
  });

  // Extracts the static SQL text (literal chunks) from a drizzle `sql` object so
  // a test can assert WHICH table/status a statement targets. Bound params
  // (e.g. ${deletionJobId}) are separate chunks and intentionally excluded;
  // literals like 'completed' / 'failed' are part of the static text.
  function sqlText(arg: unknown): string {
    const chunks = (arg as { queryChunks?: unknown[] })?.queryChunks;
    if (!Array.isArray(chunks)) return String(arg);
    return chunks
      .map((c) => {
        const v = (c as { value?: unknown }).value;
        return Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
      })
      .join(" ");
  }

  describe("deletion_jobs finalization (O-1)", () => {
    it("marks the deletion_jobs row 'completed' with completed_at on success", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      setupTenantDb(mockExecute);
      const step = makeStep();

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "full" } },
        step,
      });

      const stepNames: string[] = (
        step.run as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => c[0] as string);
      expect(stepNames).toContain("finalize-deletion-job");

      const finalizeSql = mockExecute.mock.calls
        .map(([arg]) => sqlText(arg))
        .find((t) => t.includes("ingestion.deletion_jobs"));
      expect(finalizeSql).toBeDefined();
      expect(finalizeSql).toContain("status");
      expect(finalizeSql).toContain("'completed'");
      expect(finalizeSql).toContain("completed_at");
    });

    it("does NOT finalize when the event carries no deletionJobId (legacy event)", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      setupTenantDb(mockExecute);
      const step = makeStep();

      const { deletionJobId: _omit, ...legacyEvent } = BASE_EVENT;
      await capturedHandler!({
        event: { data: { ...legacyEvent, mode: "connection_only" } },
        step,
      });

      const stepNames: string[] = (
        step.run as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => c[0] as string);
      expect(stepNames).not.toContain("finalize-deletion-job");
      const finalizeSql = mockExecute.mock.calls
        .map(([arg]) => sqlText(arg))
        .find((t) => t.includes("ingestion.deletion_jobs"));
      expect(finalizeSql).toBeUndefined();
    });

    it("on-failure companion marks the deletion_jobs row 'failed' with the error", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      setupTenantDb(mockExecute);
      const step = makeStep();

      expect(capturedOnFailure).toBeTypeOf("function");
      await capturedOnFailure!({
        event: {
          data: {
            event: {
              data: {
                deletionJobId: "djob-del-1",
                orgId: "org-del",
                workspaceId: "ws-del",
              },
            },
            error: { message: "neo4j unreachable" },
          },
        },
        step,
      });

      const stepNames: string[] = (
        step.run as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => c[0] as string);
      expect(stepNames).toContain("mark-deletion-job-failed");

      const failSql = mockExecute.mock.calls
        .map(([arg]) => sqlText(arg))
        .find((t) => t.includes("ingestion.deletion_jobs"));
      expect(failSql).toBeDefined();
      expect(failSql).toContain("'failed'");
      expect(failSql).toContain("completed_at");
      expect(mocks.loggerError).toHaveBeenCalledWith(
        expect.objectContaining({ deletionJobId: "djob-del-1" }),
        expect.stringContaining("marked deletion job failed"),
      );
    });

    it("on-failure companion is a no-op when the failure envelope lacks ids", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      setupTenantDb(mockExecute);
      const step = makeStep();

      await capturedOnFailure!({
        event: { data: { event: { data: {} }, error: { message: "x" } } },
        step,
      });

      expect((step.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe("mark-deleting step", () => {
    it("always runs regardless of mode", async () => {
      for (const mode of ["connection_only", "data_only", "full"] as const) {
        vi.clearAllMocks();
        setupTenantDb();
        setupScopedSession();

        const step = makeStep();

        await capturedHandler!({
          event: { data: { ...BASE_EVENT, mode } },
          step,
        });

        const stepRun = step.run as ReturnType<typeof vi.fn>;
        const stepNames: string[] = stepRun.mock.calls.map(
          (c) => c[0] as string,
        );
        expect(stepNames[0]).toBe("mark-deleting");
      }
    });
  });

  // ── Graph-progress counters (production defect, 2026-09-17) ────────────────
  //
  // Neo4j's `count()` arrives as the driver's Integer ({low, high}), and
  // `Integer + Integer` coerces through Symbol.toPrimitive to a **BigInt**.
  // Inngest memoizes each step's output as JSON, which cannot represent a
  // BigInt, so the summed `deleted` key was dropped from the memoized output
  // and the handler read `undefined` on replay. drizzle's `sql` tag emits an
  // EMPTY CHUNK for `undefined` — no placeholder, no parameter — so the
  // finalize UPDATE went out as the literal text
  //   SET deleted_entities = , alias_promotions = $1
  // and Postgres rejected it with a syntax error at character 187, every
  // ~65 seconds, leaving five deletion_jobs rows stuck in 'running' (the
  // oldest for a week) because each Inngest retry failed the same way.
  //
  // These tests drive the real shapes through the real memoization, and assert
  // on the RENDERED SQL — the text Postgres would actually parse — because an
  // assertion over drizzle's string chunks alone cannot see a missing param.
  describe("graph progress counters survive memoization as numbers", () => {
    /**
     * Stand-in for neo4j-driver's Integer. Only the two properties that caused
     * the outage are modelled, both verified against neo4j-driver 5.28.3:
     * `toNumber()` returns a JS number, and arithmetic coerces to a BigInt.
     */
    function neoInt(n: number): object {
      return {
        low: n,
        high: 0,
        toNumber: () => n,
        [Symbol.toPrimitive]: (hint: string) =>
          hint === "string" ? String(n) : BigInt(n),
      };
    }

    /**
     * A step runner that memoizes like Inngest: the callback's return value
     * makes a JSON round-trip, and anything JSON cannot represent is dropped
     * rather than thrown. `makeStep` above hands the value back untouched, so
     * only this one reproduces the replay path the defect lived on.
     */
    function makeMemoizingStep(): HandlerCtx["step"] {
      return {
        run: vi.fn(async (_name: string, fn: () => unknown) => {
          const out = await fn();
          return JSON.parse(
            JSON.stringify(out, (_k, v) =>
              typeof v === "bigint" ? undefined : v,
            ) ?? "null",
          );
        }),
      };
    }

    /** The SQL Postgres would parse, plus its bound parameters. */
    function rendered(arg: unknown): { sql: string; params: unknown[] } {
      const q = new PgDialect().sqlToQuery(arg as SQL);
      return { sql: q.sql, params: q.params };
    }

    function finalizeQuery(
      mockExecute: ReturnType<typeof vi.fn>,
    ): { sql: string; params: unknown[] } | undefined {
      return mockExecute.mock.calls
        .map(([arg]) => rendered(arg))
        .find((q) => q.sql.includes("deleted_entities"));
    }

    beforeEach(() => {
      mocks.scopedSession.mockReturnValue({
        run: mocks.scopedSessionRun,
        close: mocks.scopedSessionClose,
      });
    });

    it("binds both counters as parameters when Neo4j returns driver Integers", async () => {
      mocks.scopedSessionRun.mockResolvedValue({
        records: [
          { get: (k: string) => (k === "leftover" ? 0 : neoInt(3190)) },
        ],
      });
      const mockExecute = vi.fn().mockResolvedValue([]);
      setupTenantDb(mockExecute);

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "full" } },
        step: makeMemoizingStep(),
      });

      const q = finalizeQuery(mockExecute);
      expect(q).toBeDefined();
      // The defect rendered `deleted_entities = ,` — a parameter that vanished.
      expect(q!.sql).not.toMatch(/deleted_entities\s*=\s*,/);
      expect(q!.sql).toMatch(/deleted_entities\s*=\s*\$\d/);
      expect(q!.sql).toMatch(/alias_promotions\s*=\s*\$\d/);
    });

    it("writes plain numbers, never the driver's {low, high} object", async () => {
      mocks.scopedSessionRun.mockResolvedValue({
        records: [{ get: (k: string) => (k === "leftover" ? 0 : neoInt(7)) }],
      });
      const mockExecute = vi.fn().mockResolvedValue([]);
      setupTenantDb(mockExecute);

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "full" } },
        step: makeMemoizingStep(),
      });

      const q = finalizeQuery(mockExecute)!;
      // Pass 2 (7) + Pass 3 (7) deleted; Pass 1 promoted 7.
      expect(q.params).toContain(14);
      expect(q.params).toContain(7);
      for (const p of q.params) expect(typeof p).not.toBe("object");
    });

    it("falls back to zero when the memoized step output lost a counter", async () => {
      mocks.scopedSessionRun.mockResolvedValue({
        records: [{ get: (k: string) => (k === "leftover" ? 0 : neoInt(5)) }],
      });
      const mockExecute = vi.fn().mockResolvedValue([]);
      setupTenantDb(mockExecute);
      // A step that replays output missing `deleted` entirely — the exact
      // shape production read back. The finalizer must still emit valid SQL.
      const step: HandlerCtx["step"] = {
        run: vi.fn(async (name: string, fn: () => unknown) => {
          const out = await fn();
          return name === "delete-neo4j-data" ? { promoted: 5 } : out;
        }),
      };

      await capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "full" } },
        step,
      });

      const q = finalizeQuery(mockExecute)!;
      expect(q.sql).not.toMatch(/deleted_entities\s*=\s*,/);
      expect(q.params).toContain(0);
    });
  });
});

// ── Alias promotion writes, so it must be anchored to the whole tenant ───────
//
// Pass 1 of `delete-neo4j-data` OVERWRITES the promoted alias's identity fields
// (naturalKey, displayName, properties) and MERGEs/DELETEs edges off `other`.
// Anchoring one endpoint of a two-endpoint match leaves the others free, and
// the read surface treats the workspace as an isolation boundary for
// :GraphNode — graph.node.list, graph.stats, graph.search, ontology.neighbors,
// ontology.query and reference.search all filter on orgId AND workspaceId — so
// a node a sibling workspace cannot READ must not be one this job OVERWRITES.
//
// These tests EVALUATE the shipped predicate against constructed node bags
// rather than asserting that the query text contains a substring. A
// string-contains assertion cannot tell a same-org-different-workspace row from
// a different-org one, which is precisely the distinction that has to hold:
// the org predicate passes for every workspace inside that org, and a
// workspace id is not unique across organisations, so neither predicate implies
// the other and each must be shown to refuse a row the other accepts.

const ALIAS_PROMOTION_SOURCE = readFileSync(
  new URL("../ingestion.delete.ts", import.meta.url),
  "utf8",
);

/** A constructed Neo4j node, as the promotion query would see it. */
interface GraphNodeBag {
  readonly name: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly connectionId?: string;
}

const P_ORG = "org-del";
const P_WS = "ws-del";
const P_CONN = "conn-delete-1";

/**
 * Lift one predicate block out of the SHIPPED query text.
 *
 * Reading the source is what makes these assertions evaluate what actually
 * runs: a constant redeclared in the test would keep passing after the query
 * lost its anchor. `//` line comments are stripped first — the query carries
 * several, and they contain the word AND.
 */
function shippedConjuncts(startMarker: string, endMarker: string): string[] {
  const from = ALIAS_PROMOTION_SOURCE.indexOf(startMarker);
  if (from === -1) throw new Error(`query start not found: ${startMarker}`);
  const to = ALIAS_PROMOTION_SOURCE.indexOf(endMarker, from);
  if (to === -1) throw new Error(`query end not found: ${endMarker}`);
  return ALIAS_PROMOTION_SOURCE.slice(from + startMarker.length, to)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .join(" ")
    .replace(/^\s*WHERE\b/, "")
    .split(/\bAND\b/)
    .map((c) => c.trim().replace(/\s+/g, " "))
    .filter((c) => c.length > 0);
}

/**
 * Evaluate those conjuncts the way Neo4j would, against constructed bags.
 *
 * An unrecognised conjunct THROWS rather than being skipped, so a later edit
 * cannot quietly make these assertions vacuous.
 */
function predicateAccepts(
  conjuncts: string[],
  bindings: Record<string, GraphNodeBag>,
): boolean {
  const params: Record<string, string> = {
    orgId: P_ORG,
    workspaceId: P_WS,
    connectionId: P_CONN,
  };
  return conjuncts.every((conjunct) => {
    const prop =
      /^(\w+)\.(orgId|workspaceId|connectionId) (=|<>) \$(orgId|workspaceId|connectionId)$/.exec(
        conjunct,
      );
    if (prop) {
      const bag = bindings[prop[1]!];
      if (!bag) throw new Error(`no bag bound for "${prop[1]}"`);
      const actual = bag[prop[2]! as "orgId" | "workspaceId" | "connectionId"];
      const expected = params[prop[4]!];
      return prop[3] === "=" ? actual === expected : actual !== expected;
    }
    // Node identity, not a property: `WHERE other <> promoted`.
    const identity = /^(\w+) (=|<>) (\w+)$/.exec(conjunct);
    if (identity) {
      const left = bindings[identity[1]!];
      const right = bindings[identity[3]!];
      if (!left || !right) throw new Error(`unbound node in "${conjunct}"`);
      const same = left.name === right.name;
      return identity[2] === "=" ? same : !same;
    }
    throw new Error(
      `predicateAccepts cannot evaluate "${conjunct}" — teach it the new ` +
        `clause rather than letting these assertions go vacuous.`,
    );
  });
}

describe("alias promotion only reaches nodes inside the whole tenant", () => {
  const selection = () =>
    shippedConjuncts(
      "MATCH (alias:EntityNode)-[r:ALIAS_OF]->(principal:EntityNode)",
      "WITH principal, alias, r",
    );

  const principal: GraphNodeBag = {
    name: "principal",
    orgId: P_ORG,
    workspaceId: P_WS,
    connectionId: P_CONN,
  };
  const alias: GraphNodeBag = {
    name: "alias",
    orgId: P_ORG,
    workspaceId: P_WS,
    connectionId: "conn-other",
  };

  it("promotes an alias wholly inside the tenant", () => {
    expect(predicateAccepts(selection(), { principal, alias })).toBe(true);
  });

  it("refuses an alias belonging to another ORGANISATION", () => {
    expect(
      predicateAccepts(selection(), {
        principal,
        alias: { ...alias, orgId: "org-intruder" },
      }),
    ).toBe(false);
  });

  it("refuses an alias in a sibling WORKSPACE of the same org", () => {
    // The row the org predicate cannot refuse. Promotion overwrites this
    // node's naturalKey, displayName and properties, so accepting it is a
    // write into a workspace this job was not invoked for.
    expect(
      predicateAccepts(selection(), {
        principal,
        alias: { ...alias, workspaceId: "ws-sibling" },
      }),
    ).toBe(false);
  });

  it("refuses an alias sharing a workspace id across organisations", () => {
    // And the mirror: a workspace id is not unique across orgs, so only the
    // org predicate refuses this one. Neither predicate covers for the other.
    expect(
      predicateAccepts(selection(), {
        principal,
        alias: { ...alias, orgId: "org-intruder", workspaceId: P_WS },
      }),
    ).toBe(false);
  });

  it("refuses a principal in a sibling workspace", () => {
    // The principal is the anchor every other row is selected through, so it
    // carries the full tenant too.
    expect(
      predicateAccepts(selection(), {
        principal: { ...principal, workspaceId: "ws-sibling" },
        alias,
      }),
    ).toBe(false);
  });

  it("still refuses an alias from the connection being deleted", () => {
    // The pre-existing guard, pinned so a tenancy edit cannot drop it.
    expect(
      predicateAccepts(selection(), {
        principal,
        alias: { ...alias, connectionId: P_CONN },
      }),
    ).toBe(false);
  });
});

describe("the ALIAS_OF reroute only reaches nodes inside the whole tenant", () => {
  const reroute = () =>
    shippedConjuncts(
      "OPTIONAL MATCH (other:EntityNode)-[old:ALIAS_OF]->(principal)",
      "FOREACH (o IN CASE WHEN other IS NULL",
    );

  const promoted: GraphNodeBag = {
    name: "promoted",
    orgId: P_ORG,
    workspaceId: P_WS,
  };
  const other: GraphNodeBag = {
    name: "other",
    orgId: P_ORG,
    workspaceId: P_WS,
  };

  it("reroutes an edge off a node inside the tenant", () => {
    expect(predicateAccepts(reroute(), { other, promoted })).toBe(true);
  });

  it("refuses to reroute an edge off another ORGANISATION's node", () => {
    expect(
      predicateAccepts(reroute(), {
        other: { ...other, orgId: "org-intruder" },
        promoted,
      }),
    ).toBe(false);
  });

  it("refuses to reroute an edge off a sibling WORKSPACE's node", () => {
    // This branch MERGEs a new edge off `other` and DELETEs its existing one.
    // Both are writes, and the org predicate alone lets this row through.
    expect(
      predicateAccepts(reroute(), {
        other: { ...other, workspaceId: "ws-sibling" },
        promoted,
      }),
    ).toBe(false);
  });

  it("still refuses to reroute the promoted node onto itself", () => {
    expect(predicateAccepts(reroute(), { other: promoted, promoted })).toBe(
      false,
    );
  });
});

describe("the promotion query is handed the workspace it anchors on", () => {
  beforeEach(setupScopedSession);

  it("passes workspaceId alongside connectionId and orgId", async () => {
    // The seam overwrites $orgId/$workspaceId on every run, so this is about
    // the call site reading honestly — but it also proves the handler has the
    // workspace in scope at the point the query claims to use it.
    await capturedHandler!({
      event: { data: { ...BASE_EVENT, mode: "data_only" } },
      step: makeStep(),
    });

    const promotionCall = mocks.scopedSessionRun.mock.calls.find(
      ([cypher]) => typeof cypher === "string" && cypher.includes("ALIAS_OF"),
    );
    expect(promotionCall).toBeDefined();
    expect(promotionCall![1]).toMatchObject({
      connectionId: BASE_EVENT.connectionId,
      orgId: BASE_EVENT.orgId,
      workspaceId: BASE_EVENT.workspaceId,
    });
  });
});

// ── What survives a deletion: the four passes enumerated ────────────────────
//
// Pass 1 promotes, Pass 2 removes this connection's `:EntityNode`s, Pass 3
// removes everything else it stamped, Pass 4 removes the meta-node. Those are
// four rules that have to AGREE about what survives, and they did not: Pass 2
// carried
//
//     WHERE NOT ((:EntityNode)-[:ALIAS_OF]->(n))
//
// described as deleting "only nodes that have no remaining incoming ALIAS_OF
// edges (they were either promoted above or were never aliased)". Promotion does
// not delete the edge it promoted along, and Pass 1 must not write to an alias
// in another workspace, so "remaining" covered four populations rather than
// none — and Pass 3 excludes `:EntityNode`, so no pass claimed them. The job
// then deleted the Postgres connection and reported `completed`.
//
// These tests MODEL the four passes rather than run them: there is no Neo4j in
// the unit environment. The model is tied to the shipped code two ways — Pass 1's
// eligibility and reroute predicates are lifted out of the source by
// `shippedConjuncts` and evaluated by `predicateAccepts`, and the shape of each
// remaining pass is asserted against the source text below. A model that drifts
// from the query fails rather than reassures.

interface ModelNode extends GraphNodeBag {
  readonly labels: readonly string[];
  naturalKey?: string;
  displayName?: string;
}
interface ModelEdge {
  readonly type: "ALIAS_OF" | "CONTAINS";
  from: string;
  to: string;
  readonly confidence?: number;
}
interface ModelGraph {
  nodes: ModelNode[];
  edges: ModelEdge[];
}

const PASS_1_SELECTION = () =>
  shippedConjuncts(
    "MATCH (alias:EntityNode)-[r:ALIAS_OF]->(principal:EntityNode)",
    "WITH principal, alias, r",
  );
const PASS_1_REROUTE = () =>
  shippedConjuncts(
    "OPTIONAL MATCH (other:EntityNode)-[old:ALIAS_OF]->(principal)",
    "FOREACH (o IN CASE WHEN other IS NULL",
  );

/** Lift one pass's query text out of the shipped source. */
function shippedQuery(startMarker: string): string {
  const from = ALIAS_PROMOTION_SOURCE.indexOf(startMarker);
  if (from === -1) throw new Error(`pass not found: ${startMarker}`);
  const end = ALIAS_PROMOTION_SOURCE.indexOf("`,", from);
  return ALIAS_PROMOTION_SOURCE.slice(from, end);
}

/**
 * Run the four passes over a constructed graph and report what is left.
 *
 * Returns the surviving nodes and edges plus the promotion count the job would
 * record on the `deletion_jobs` row.
 */
function runDeletion(graph: ModelGraph): {
  survivors: ModelNode[];
  edges: ModelEdge[];
  promoted: number;
} {
  const nodes = graph.nodes.map((n) => ({ ...n }));
  let edges = graph.edges.map((e) => ({ ...e }));
  const byName = (name: string) => nodes.find((n) => n.name === name)!;
  const isEntity = (n: ModelNode) => n.labels.includes("EntityNode");
  const ours = (n: ModelNode) => n.connectionId === P_CONN && n.orgId === P_ORG;

  // ── Pass 1 ────────────────────────────────────────────────────────────────
  const promotedNodes = new Set<string>();
  for (const principal of nodes.filter(
    (n) => isEntity(n) && n.connectionId === P_CONN,
  )) {
    const eligible = edges
      .filter(
        (e) =>
          e.type === "ALIAS_OF" &&
          e.to === principal.name &&
          isEntity(byName(e.from)) &&
          predicateAccepts(PASS_1_SELECTION(), {
            principal,
            alias: byName(e.from),
          }),
      )
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    const top = eligible[0];
    if (!top) continue;
    const promoted = byName(top.from);
    promoted.naturalKey = principal.naturalKey;
    promoted.displayName = principal.displayName;
    promotedNodes.add(promoted.name);
    // Reroute the OTHER local aliases onto the promoted node.
    for (const e of edges.filter(
      (x) => x.type === "ALIAS_OF" && x.to === principal.name && x !== top,
    )) {
      if (
        predicateAccepts(PASS_1_REROUTE(), {
          other: byName(e.from),
          promoted,
        })
      ) {
        e.to = promoted.name;
      }
    }
  }

  // ── Pass 2 ────────────────────────────────────────────────────────────────
  // DETACH DELETE takes the node's edges with it, whichever end of them is
  // foreign. Whether it is CONDITIONAL is read out of the shipped query rather
  // than assumed, so these scenarios fail against the version that carried
  // `WHERE NOT ((:EntityNode)-[:ALIAS_OF]->(n))` instead of merely describing
  // what the fixed version ought to do.
  const detachDelete = (doomed: ModelNode[]) => {
    const names = new Set(doomed.map((n) => n.name));
    edges = edges.filter((e) => !names.has(e.from) && !names.has(e.to));
    for (const n of doomed) nodes.splice(nodes.indexOf(n), 1);
    return doomed.length;
  };
  const pass2SkipsAliased = shippedQuery(
    "MATCH (n:EntityNode {connectionId: $connectionId, orgId: $orgId})",
  ).includes("WHERE NOT ((:EntityNode)-[:ALIAS_OF]->(n))");
  detachDelete(
    nodes.filter(
      (n) =>
        isEntity(n) &&
        ours(n) &&
        !(
          pass2SkipsAliased &&
          edges.some(
            (e) =>
              e.type === "ALIAS_OF" &&
              e.to === n.name &&
              nodes.some((x) => x.name === e.from && isEntity(x)),
          )
        ),
    ),
  );

  // ── Pass 3 ────────────────────────────────────────────────────────────────
  detachDelete(nodes.filter((n) => !isEntity(n) && ours(n)));

  // ── Pass 4 ────────────────────────────────────────────────────────────────
  detachDelete(
    nodes.filter(
      (n) => n.labels.includes("SourceConnection") && n.orgId === P_ORG,
    ),
  );

  return { survivors: nodes, edges, promoted: promotedNodes.size };
}

const ourNode = (name: string, extra: Partial<ModelNode> = {}): ModelNode => ({
  name,
  labels: ["EntityNode"],
  orgId: P_ORG,
  workspaceId: P_WS,
  connectionId: P_CONN,
  naturalKey: `nk-${name}`,
  displayName: name,
  ...extra,
});
const otherConn = (name: string, extra: Partial<ModelNode> = {}): ModelNode =>
  ourNode(name, { connectionId: "conn-other", ...extra });

describe("nothing this connection created survives its deletion", () => {
  it("the model matches the shipped passes", () => {
    // Pass 2 deletes unconditionally: no WHERE at all. This is the assertion
    // that ties the model above to the code, and the one that fails if the
    // alias condition is ever reinstated.
    const pass2 = shippedQuery(
      "MATCH (n:EntityNode {connectionId: $connectionId, orgId: $orgId})",
    );
    expect(pass2).toContain("DETACH DELETE n");
    expect(pass2).not.toContain("WHERE");
    expect(pass2).not.toContain("ALIAS_OF");
    // Pass 3 is unchanged: everything non-EntityNode, unconditionally.
    const pass3 = shippedQuery("MATCH (n {connectionId: $connectionId");
    expect(pass3).toContain("WHERE NOT n:EntityNode");
    expect(pass3).toContain("DETACH DELETE n");
  });

  const scenarios: Array<{
    name: string;
    graph: ModelGraph;
    /** Nodes that must survive — every one of them foreign. */
    survives: string[];
    promoted: number;
  }> = [
    {
      name: "a plain node with no aliases",
      graph: { nodes: [ourNode("p")], edges: [] },
      survives: [],
      promoted: 0,
    },
    {
      // The ordinary promotion, and it was broken too: Pass 1 never deletes the
      // edge it promoted ALONG, so `r` pinned the principal in Pass 2.
      name: "a principal whose local alias is promoted",
      graph: {
        nodes: [ourNode("p"), otherConn("a")],
        edges: [{ type: "ALIAS_OF", from: "a", to: "p", confidence: 0.9 }],
      },
      survives: ["a"],
      promoted: 1,
    },
    {
      // The reported case.
      name: "a principal aliased from a sibling WORKSPACE",
      graph: {
        nodes: [
          ourNode("p"),
          otherConn("foreign", { workspaceId: "ws-sibling" }),
        ],
        edges: [
          { type: "ALIAS_OF", from: "foreign", to: "p", confidence: 0.9 },
        ],
      },
      survives: ["foreign"],
      promoted: 0,
    },
    {
      name: "a principal aliased from another ORGANISATION",
      graph: {
        nodes: [ourNode("p"), otherConn("foreign", { orgId: "org-other" })],
        edges: [
          { type: "ALIAS_OF", from: "foreign", to: "p", confidence: 0.9 },
        ],
      },
      survives: ["foreign"],
      promoted: 0,
    },
    {
      // Excluded from promotion by `alias.connectionId <> $connectionId`, and
      // the alias itself is deleted, so the principal was left with no edges.
      name: "a principal aliased from THIS connection",
      graph: {
        nodes: [ourNode("p"), ourNode("a2")],
        edges: [{ type: "ALIAS_OF", from: "a2", to: "p", confidence: 0.9 }],
      },
      survives: [],
      promoted: 0,
    },
    {
      name: "a principal aliased from a local node AND a foreign one",
      graph: {
        nodes: [
          ourNode("p"),
          otherConn("local", { name: "local" }),
          otherConn("foreign", { workspaceId: "ws-sibling" }),
        ],
        edges: [
          { type: "ALIAS_OF", from: "local", to: "p", confidence: 0.9 },
          { type: "ALIAS_OF", from: "foreign", to: "p", confidence: 0.5 },
        ],
      },
      survives: ["local", "foreign"],
      promoted: 1,
    },
    {
      name: "a principal aliased from two foreign workspaces",
      graph: {
        nodes: [
          ourNode("p"),
          otherConn("f1", { workspaceId: "ws-a" }),
          otherConn("f2", { workspaceId: "ws-b" }),
        ],
        edges: [
          { type: "ALIAS_OF", from: "f1", to: "p", confidence: 0.9 },
          { type: "ALIAS_OF", from: "f2", to: "p", confidence: 0.5 },
        ],
      },
      survives: ["f1", "f2"],
      promoted: 0,
    },
    {
      name: "an alias chain through one of our nodes",
      graph: {
        nodes: [ourNode("p"), otherConn("a"), otherConn("q")],
        edges: [
          { type: "ALIAS_OF", from: "a", to: "p", confidence: 0.9 },
          { type: "ALIAS_OF", from: "p", to: "q", confidence: 0.8 },
        ],
      },
      survives: ["a", "q"],
      promoted: 1,
    },
    {
      // Outgoing edges were never the problem: DETACH DELETE of our endpoint
      // takes them. Pinned so the fix is not credited with something already
      // true.
      name: "an outgoing alias to a foreign node",
      graph: {
        nodes: [
          ourNode("p"),
          otherConn("foreign", { workspaceId: "ws-sibling" }),
        ],
        edges: [
          { type: "ALIAS_OF", from: "p", to: "foreign", confidence: 0.9 },
        ],
      },
      survives: ["foreign"],
      promoted: 0,
    },
    {
      name: "non-EntityNode artifacts and the meta-node",
      graph: {
        nodes: [
          ourNode("file", { labels: ["SourceFile"] }),
          ourNode("sym", { labels: ["SourceSymbol"] }),
          {
            name: "sc",
            labels: ["SourceConnection"],
            orgId: P_ORG,
            workspaceId: P_WS,
          },
        ],
        edges: [{ type: "CONTAINS", from: "file", to: "sym" }],
      },
      survives: [],
      promoted: 0,
    },
  ];

  for (const { name, graph, survives, promoted } of scenarios) {
    it(`leaves nothing behind: ${name}`, () => {
      const result = runDeletion(graph);
      expect(result.survivors.map((n) => n.name).sort()).toEqual(
        [...survives].sort(),
      );
      // Nothing that survives belongs to this connection.
      for (const n of result.survivors) {
        expect(n.connectionId).not.toBe(P_CONN);
      }
      // No edge survives with an endpoint that is gone.
      const live = new Set(result.survivors.map((n) => n.name));
      for (const e of result.edges) {
        expect(live.has(e.from) && live.has(e.to)).toBe(true);
      }
      expect(result.promoted).toBe(promoted);
    });
  }

  // THE FOREIGN ENDPOINT IS NOT THIS JOB'S TO MODIFY, and that is the half a
  // deletion can most easily get wrong: taking the edge is in scope, taking or
  // rewriting the node at its other end is not.
  it("never deletes or rewrites a node outside this workspace", () => {
    const foreignShapes: ModelGraph[] = scenarios
      .map((s) => s.graph)
      .filter((g) =>
        g.nodes.some((n) => n.workspaceId !== P_WS || n.orgId !== P_ORG),
      );
    expect(foreignShapes.length).toBeGreaterThan(3);

    for (const graph of foreignShapes) {
      const before = graph.nodes
        .filter((n) => n.workspaceId !== P_WS || n.orgId !== P_ORG)
        .map((n) => JSON.stringify(n));
      const after = runDeletion(graph).survivors.map((n) => JSON.stringify(n));
      for (const snapshot of before) {
        // Present, and byte-identical: no naturalKey, displayName or property
        // of a foreign node is touched.
        expect(after).toContain(snapshot);
      }
    }
  });

  it("the promotion count records work that actually happened", () => {
    // A principal with exactly ONE alias is the ordinary case, and it used to
    // report zero promotions: the reroute was a plain MATCH, so the row was
    // discarded after the SET had already run.
    const single = runDeletion({
      nodes: [ourNode("p"), otherConn("a")],
      edges: [{ type: "ALIAS_OF", from: "a", to: "p", confidence: 0.9 }],
    });
    expect(single.promoted).toBe(1);
    // …and a principal with three local aliases is still one promotion.
    const many = runDeletion({
      nodes: [ourNode("p"), otherConn("a"), otherConn("b"), otherConn("c")],
      edges: [
        { type: "ALIAS_OF", from: "a", to: "p", confidence: 0.9 },
        { type: "ALIAS_OF", from: "b", to: "p", confidence: 0.5 },
        { type: "ALIAS_OF", from: "c", to: "p", confidence: 0.1 },
      ],
    });
    expect(many.promoted).toBe(1);
  });

  it("the promotion query counts distinct promotions, not rerouted rows", () => {
    // The model's claim above, checked against the shipped text: OPTIONAL so a
    // lone promotion still yields a row, DISTINCT so several reroutes do not
    // multiply it.
    const promotion = shippedQuery(
      "MATCH (alias:EntityNode)-[r:ALIAS_OF]->(principal:EntityNode)",
    );
    expect(promotion).toContain("OPTIONAL MATCH (other:EntityNode)");
    expect(promotion).toContain("count(DISTINCT promoted) AS promoted");
  });
});

// ── "Completed" is a claim, and Pass 5 is what checks it ────────────────────
//
// Passes 2-4 delete unconditionally, so on the rules as written nothing this
// connection stamped can survive. That is an argument about the queries — and
// the defect this pass exists to catch is exactly an argument about the queries
// that turned out to be wrong. Pass 2's alias condition was described as
// covering nodes that "were either promoted above or were never aliased"; it
// covered neither of two further populations, and the job went on to delete the
// Postgres connection and report `completed` with the graph entity and its
// cross-workspace edge still in place.
describe("the deletion job verifies rather than assumes", () => {
  beforeEach(setupScopedSession);

  it("asks whether anything survived, scoped to the connection and org", async () => {
    await capturedHandler!({
      event: { data: { ...BASE_EVENT, mode: "data_only" } },
      step: makeStep(),
    });

    const probe = (
      mocks.scopedSessionRun.mock.calls as Array<[string, unknown]>
    ).find(([cypher]) => cypher.includes("AS leftover"));

    expect(probe).toBeDefined();
    expect(probe![0]).toContain(
      "MATCH (n {connectionId: $connectionId, orgId: $orgId})",
    );
    // A COUNT, not a delete: the verification must not be able to paper over a
    // survivor by removing it.
    expect(probe![0]).not.toContain("DELETE");
    expect(probe![1]).toMatchObject({
      connectionId: BASE_EVENT.connectionId,
      orgId: BASE_EVENT.orgId,
    });
  });

  it("runs AFTER every delete pass, or it would prove nothing", async () => {
    await capturedHandler!({
      event: { data: { ...BASE_EVENT, mode: "data_only" } },
      step: makeStep(),
    });

    const cyphers = (
      mocks.scopedSessionRun.mock.calls as Array<[string, unknown]>
    ).map(([c]) => c);
    const probeAt = cyphers.findIndex((c) => c.includes("AS leftover"));
    const lastDeleteAt = cyphers.reduce(
      (acc, c, i) => (c.includes("DETACH DELETE") ? i : acc),
      -1,
    );
    expect(probeAt).toBeGreaterThan(lastDeleteAt);
    expect(lastDeleteAt).toBeGreaterThan(-1);
  });

  it("refuses to report completion when a node survived", async () => {
    // The deletion counters still come back happy; only the probe disagrees.
    // A job that finished its passes and left data behind must say so, because
    // nothing else will prompt anyone to look.
    mocks.scopedSessionRun.mockResolvedValue({
      records: [{ get: (k: string) => (k === "leftover" ? 2 : 0) }],
    });

    await expect(
      capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "data_only" } },
        step: makeStep(),
      }),
    ).rejects.toThrow(/survived deletion/);
  });

  it("names how many survived and which connection", async () => {
    mocks.scopedSessionRun.mockResolvedValue({
      records: [{ get: (k: string) => (k === "leftover" ? 3 : 0) }],
    });

    await expect(
      capturedHandler!({
        event: { data: { ...BASE_EVENT, mode: "data_only" } },
        step: makeStep(),
      }),
    ).rejects.toThrow(
      new RegExp(
        `3 graph node\\(s\\) for connection ${BASE_EVENT.connectionId}`,
      ),
    );
  });

  it("does not run in connection_only mode, which touches no graph", async () => {
    await capturedHandler!({
      event: { data: { ...BASE_EVENT, mode: "connection_only" } },
      step: makeStep(),
    });

    const cyphers = (
      mocks.scopedSessionRun.mock.calls as Array<[string, unknown]>
    ).map(([c]) => c);
    expect(cyphers.some((c) => c.includes("AS leftover"))).toBe(false);
  });

  it("reads the count through countOf, like every other counter here", () => {
    // A driver Integer is `{low, high}`, and `> 0` on that object is false for
    // every value — the probe would pass while nodes survived. This is the
    // defect the counter tests above already pin for the OTHER counters.
    const source = ALIAS_PROMOTION_SOURCE;
    const probeBlock = source.slice(
      source.indexOf("AS leftover"),
      source.indexOf("survived deletion"),
    );
    expect(probeBlock).toContain("countOf(");
  });
});
