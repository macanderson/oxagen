import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  createFunction: vi.fn(),
  withTenantDb: vi.fn(),
  runInTenantScope: vi.fn(),
  loggerInfo: vi.fn(),
  // scopedSession: returns records for alias promotion + deletion pass
  scopedSessionRun: vi.fn(),
  scopedSessionClose: vi.fn().mockResolvedValue(undefined),
  scopedSession: vi.fn(),
}));

type HandlerCtx = {
  event: { data: unknown };
  step: {
    run: (name: string, fn: () => unknown) => Promise<unknown>;
  };
};
let capturedHandler: ((ctx: HandlerCtx) => unknown) | null = null;

mocks.createFunction.mockImplementation(
  (_opts: unknown, _trigger: unknown, handler: typeof capturedHandler) => {
    capturedHandler = handler;
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
  logger: { info: mocks.loggerInfo, debug: vi.fn(), error: vi.fn() },
}));

await import("../ingestion.delete");

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_EVENT = {
  connectionId: "conn-delete-1",
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
        const stepNames: string[] = stepRun.mock.calls.map((c) => c[0] as string);
        expect(stepNames[0]).toBe("mark-deleting");
      }
    });
  });
});
