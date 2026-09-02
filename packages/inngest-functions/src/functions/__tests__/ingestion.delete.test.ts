import { describe, it, expect, vi, beforeEach } from "vitest";

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
  return {
    ...real,
    withTenantDb: mocks.withTenantDb,
  };
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
  // Default: alias promotion returns 0, delete returns 0
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
});
