/**
 * actions.test.ts — unit tests for Workspace → Evals server actions.
 *
 * Covers, per action:
 *   - zod validation (rejects bad input BEFORE invoke is called)
 *   - workspace-role gate: writer actions (create/add/start) deny "viewer";
 *     reader actions (get_dataset/get_eval_status) allow "viewer"
 *   - happy path: invoke called with the right capability name + input + a
 *     3-arg call (NO surface option — every eval.* contract's `surfaces` list
 *     is ["api","mcp","cli"], not "app"; a 4th arg would mean a surface opt
 *     slipped in and would throw surface_denied against the real handler)
 *   - invoke() rejection → { ok:false, error } with a safe fallback message
 *
 * Mock seam: @/lib/session, @/lib/resolve-org, @oxagen/database (withTenantDb
 * for the role re-read, spread importOriginal so `schema` stays real),
 * @oxagen/tenancy, @oxagen/oxagen (invoke — full replacement is safe since
 * actions.ts only imports the `invoke` value from the package root; the zod
 * schemas it imports come from the untouched @oxagen/oxagen/contracts/*
 * subpaths), @oxagen/handlers/register, @oxagen/handlers/logger, next/cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetSession,
  mockResolveOrg,
  mockResolveWorkspace,
  mockAssertOrgMember,
  mockRunInTenantScope,
  mockWithTenantDb,
  mockInvoke,
  mockRevalidatePath,
  dbState,
} = vi.hoisted(() => {
  const dbState: { wsRoleRows: Array<{ role: string }> } = {
    wsRoleRows: [{ role: "owner" }],
  };
  const mockLimit = vi.fn(() => Promise.resolve(dbState.wsRoleRows));
  const mockWhere = vi.fn(() => ({ limit: mockLimit }));
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  const mockTx = { select: mockSelect };
  const mockWithTenantDb = vi.fn((fn: (tx: typeof mockTx) => unknown) =>
    fn(mockTx),
  );
  const mockRunInTenantScope = vi.fn((_scope: unknown, fn: () => unknown) =>
    fn(),
  );
  return {
    mockGetSession: vi.fn(),
    mockResolveOrg: vi.fn(),
    mockResolveWorkspace: vi.fn(),
    mockAssertOrgMember: vi.fn(),
    mockRunInTenantScope,
    mockWithTenantDb,
    mockInvoke: vi.fn(),
    mockRevalidatePath: vi.fn(),
    dbState,
  };
});

vi.mock("@/lib/session", () => ({ getSessionOrRedirect: mockGetSession }));
vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: mockResolveOrg,
  resolveWorkspace: mockResolveWorkspace,
  assertOrgMember: mockAssertOrgMember,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));
vi.mock("@oxagen/tenancy", () => ({ runInTenantScope: mockRunInTenantScope }));
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: mockWithTenantDb,
  };
});
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  createDatasetAction,
  createTraceDatasetAction,
  addDatasetItemAction,
  getDatasetAction,
  startEvalRunAction,
  getEvalRunStatusAction,
} from "./actions";

const SESSION = { user: { id: "user-1" } };
const ORG = { id: "org-1", slug: "acme" };
const WS = { id: "ws-1", slug: "research" };

function base<T extends object>(
  overrides: T,
): { orgSlug: string; workspaceSlug: string } & T {
  return { orgSlug: "acme", workspaceSlug: "research", ...overrides };
}

describe("evals actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.wsRoleRows = [{ role: "owner" }];
    mockGetSession.mockResolvedValue(SESSION);
    mockResolveOrg.mockResolvedValue(ORG);
    mockResolveWorkspace.mockResolvedValue(WS);
    mockAssertOrgMember.mockResolvedValue(undefined);
  });

  // ---------------------------------------------------------------------------
  // createDatasetAction — eval.dataset.create
  // ---------------------------------------------------------------------------

  describe("createDatasetAction", () => {
    it("invokes create_dataset with a 3-arg call (no surface option) and returns ok:true", async () => {
      mockInvoke.mockResolvedValue({
        datasetId: "id-1",
        publicId: "evd_abc",
        slug: "smoke",
      });

      const result = await createDatasetAction(
        base({ name: "Smoke dataset", description: "d" }),
      );

      expect(result).toEqual({
        ok: true,
        datasetId: "id-1",
        publicId: "evd_abc",
        slug: "smoke",
      });
      expect(mockInvoke).toHaveBeenCalledWith(
        "create_dataset",
        { name: "Smoke dataset", description: "d" },
        expect.objectContaining({
          orgId: "org-1",
          workspaceId: "ws-1",
          userId: "user-1",
        }),
      );
      // Exactly 3 args — a surface opt would make this a 4-arg call.
      expect(mockInvoke.mock.calls[0]).toHaveLength(3);
      expect(mockRevalidatePath).toHaveBeenCalledWith("/acme/research/evals");
    });

    it("rejects an empty name before invoking", async () => {
      const result = await createDatasetAction(base({ name: "" }));

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("rejects an invalid (non-kebab-case) slug before invoking", async () => {
      const result = await createDatasetAction(
        base({ name: "x", slug: "Not Kebab!" }),
      );

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("denies a viewer without invoking", async () => {
      dbState.wsRoleRows = [{ role: "viewer" }];

      const result = await createDatasetAction(base({ name: "x" }));

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("maps an invoke() rejection to ok:false with a fallback message", async () => {
      mockInvoke.mockRejectedValue(new Error(""));

      const result = await createDatasetAction(base({ name: "x" }));

      expect(result).toEqual({ ok: false, error: "Failed to create dataset." });
    });
  });

  // ---------------------------------------------------------------------------
  // createTraceDatasetAction — eval.dataset.from_traces
  // ---------------------------------------------------------------------------

  describe("createTraceDatasetAction", () => {
    it("invokes create_trace_dataset with sinceHours/limit and returns ok:true", async () => {
      mockInvoke.mockResolvedValue({
        datasetId: "id-2",
        publicId: "evd_xyz",
        slug: "from-traces",
        itemCount: 12,
      });

      const result = await createTraceDatasetAction(
        base({ name: "From traces", sinceHours: 72, limit: 50 }),
      );

      expect(result).toEqual({
        ok: true,
        datasetId: "id-2",
        publicId: "evd_xyz",
        slug: "from-traces",
        itemCount: 12,
      });
      expect(mockInvoke).toHaveBeenCalledWith(
        "create_trace_dataset",
        { name: "From traces", sinceHours: 72, limit: 50 },
        expect.objectContaining({ orgId: "org-1", workspaceId: "ws-1" }),
      );
      expect(mockInvoke.mock.calls[0]).toHaveLength(3);
    });

    it("rejects sinceHours out of range before invoking", async () => {
      const result = await createTraceDatasetAction(
        base({ name: "x", sinceHours: 0, limit: 50 }),
      );

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("denies a viewer without invoking", async () => {
      dbState.wsRoleRows = [{ role: "viewer" }];

      const result = await createTraceDatasetAction(
        base({ name: "x", sinceHours: 24, limit: 10 }),
      );

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // addDatasetItemAction — eval.dataset_item.add
  // ---------------------------------------------------------------------------

  describe("addDatasetItemAction", () => {
    it("invokes add_dataset_item with a single-item batch", async () => {
      mockInvoke.mockResolvedValue({
        datasetId: "id-1",
        added: 1,
        itemCount: 4,
      });

      const result = await addDatasetItemAction(
        base({
          datasetPublicId: "evd_abc",
          input: "What is 2+2?",
          expectedOutput: "4",
        }),
      );

      expect(result).toEqual({
        ok: true,
        datasetId: "id-1",
        added: 1,
        itemCount: 4,
      });
      expect(mockInvoke).toHaveBeenCalledWith(
        "add_dataset_item",
        {
          datasetPublicId: "evd_abc",
          items: [{ input: "What is 2+2?", expectedOutput: "4" }],
        },
        expect.objectContaining({ orgId: "org-1" }),
      );
      expect(mockInvoke.mock.calls[0]).toHaveLength(3);
    });

    it("omits expectedOutput from the item when not provided", async () => {
      mockInvoke.mockResolvedValue({
        datasetId: "id-1",
        added: 1,
        itemCount: 1,
      });

      await addDatasetItemAction(
        base({ datasetPublicId: "evd_abc", input: "Just a question" }),
      );

      expect(mockInvoke).toHaveBeenCalledWith(
        "add_dataset_item",
        { datasetPublicId: "evd_abc", items: [{ input: "Just a question" }] },
        expect.anything(),
      );
    });

    it("rejects an empty input before invoking", async () => {
      const result = await addDatasetItemAction(
        base({ datasetPublicId: "evd_abc", input: "" }),
      );

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("denies a viewer without invoking", async () => {
      dbState.wsRoleRows = [{ role: "viewer" }];

      const result = await addDatasetItemAction(
        base({ datasetPublicId: "evd_abc", input: "x" }),
      );

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // getDatasetAction — eval.dataset.get (read; viewer allowed)
  // ---------------------------------------------------------------------------

  describe("getDatasetAction", () => {
    it("invokes get_dataset with a limit and returns ok:true", async () => {
      mockInvoke.mockResolvedValue({
        dataset: {
          datasetId: "id-1",
          name: "n",
          slug: "s",
          description: null,
          source: "manual",
          itemCount: 0,
          createdAt: "now",
        },
        items: [],
        nextCursor: null,
      });

      const result = await getDatasetAction(
        base({ datasetPublicId: "evd_abc" }),
      );

      expect(result.ok).toBe(true);
      expect(mockInvoke).toHaveBeenCalledWith(
        "get_dataset",
        { datasetPublicId: "evd_abc", limit: 50 },
        expect.objectContaining({ orgId: "org-1" }),
      );
      expect(mockInvoke.mock.calls[0]).toHaveLength(3);
    });

    it("passes cursor through when provided", async () => {
      mockInvoke.mockResolvedValue({
        dataset: {
          datasetId: "id-1",
          name: "n",
          slug: "s",
          description: null,
          source: "manual",
          itemCount: 0,
          createdAt: "now",
        },
        items: [],
        nextCursor: null,
      });

      await getDatasetAction(
        base({ datasetPublicId: "evd_abc", cursor: "evi_page2" }),
      );

      expect(mockInvoke).toHaveBeenCalledWith(
        "get_dataset",
        { datasetPublicId: "evd_abc", limit: 50, cursor: "evi_page2" },
        expect.anything(),
      );
    });

    it("ALLOWS a viewer to read (unlike the writer gate)", async () => {
      dbState.wsRoleRows = [{ role: "viewer" }];
      mockInvoke.mockResolvedValue({
        dataset: {
          datasetId: "id-1",
          name: "n",
          slug: "s",
          description: null,
          source: "manual",
          itemCount: 0,
          createdAt: "now",
        },
        items: [],
        nextCursor: null,
      });

      const result = await getDatasetAction(
        base({ datasetPublicId: "evd_abc" }),
      );

      expect(result.ok).toBe(true);
      expect(mockInvoke).toHaveBeenCalled();
    });

    it("denies a non-member (no workspace role row) without invoking", async () => {
      dbState.wsRoleRows = [];

      const result = await getDatasetAction(
        base({ datasetPublicId: "evd_abc" }),
      );

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("maps an invoke() rejection to ok:false", async () => {
      mockInvoke.mockRejectedValue(new Error("dataset not found"));

      const result = await getDatasetAction(
        base({ datasetPublicId: "evd_missing" }),
      );

      expect(result).toEqual({ ok: false, error: "dataset not found" });
    });
  });

  // ---------------------------------------------------------------------------
  // startEvalRunAction — eval.run.start
  // ---------------------------------------------------------------------------

  describe("startEvalRunAction", () => {
    it("invokes start_eval_run with a model target and returns ok:true", async () => {
      mockInvoke.mockResolvedValue({
        runId: "evr_1",
        status: "pending",
        itemCount: 5,
      });

      const result = await startEvalRunAction(
        base({
          datasetPublicId: "evd_abc",
          target: { kind: "model", model: "claude-3-haiku" },
          passThreshold: 0.7,
        }),
      );

      expect(result).toEqual({ ok: true, runId: "evr_1", itemCount: 5 });
      expect(mockInvoke).toHaveBeenCalledWith(
        "start_eval_run",
        {
          datasetPublicId: "evd_abc",
          target: { kind: "model", model: "claude-3-haiku" },
          passThreshold: 0.7,
        },
        expect.objectContaining({ orgId: "org-1" }),
      );
      expect(mockInvoke.mock.calls[0]).toHaveLength(3);
    });

    it("invokes start_eval_run with an agent target", async () => {
      mockInvoke.mockResolvedValue({
        runId: "evr_2",
        status: "pending",
        itemCount: 3,
      });

      await startEvalRunAction(
        base({
          datasetPublicId: "evd_abc",
          target: { kind: "agent", agentSlug: "support-bot" },
          passThreshold: 0.7,
          judgeModel: "claude-3-opus",
          maxItems: 10,
        }),
      );

      expect(mockInvoke).toHaveBeenCalledWith(
        "start_eval_run",
        {
          datasetPublicId: "evd_abc",
          target: { kind: "agent", agentSlug: "support-bot" },
          judgeModel: "claude-3-opus",
          passThreshold: 0.7,
          maxItems: 10,
        },
        expect.anything(),
      );
    });

    it("rejects an agent target missing agentSlug before invoking", async () => {
      const result = await startEvalRunAction(
        base({
          datasetPublicId: "evd_abc",
          target: { kind: "agent", agentSlug: "" },
          passThreshold: 0.7,
        }),
      );

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("rejects passThreshold out of [0,1] before invoking", async () => {
      const result = await startEvalRunAction(
        base({
          datasetPublicId: "evd_abc",
          target: { kind: "model" },
          passThreshold: 1.5,
        }),
      );

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("denies a viewer without invoking", async () => {
      dbState.wsRoleRows = [{ role: "viewer" }];

      const result = await startEvalRunAction(
        base({
          datasetPublicId: "evd_abc",
          target: { kind: "model" },
          passThreshold: 0.7,
        }),
      );

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("maps a billing-gate rejection to ok:false with the handler's message", async () => {
      mockInvoke.mockRejectedValue(new Error("insufficient balance"));

      const result = await startEvalRunAction(
        base({
          datasetPublicId: "evd_abc",
          target: { kind: "model" },
          passThreshold: 0.7,
        }),
      );

      expect(result).toEqual({ ok: false, error: "insufficient balance" });
    });
  });

  // ---------------------------------------------------------------------------
  // getEvalRunStatusAction — eval.run.status (read; viewer allowed)
  // ---------------------------------------------------------------------------

  describe("getEvalRunStatusAction", () => {
    it("invokes get_eval_status and returns ok:true", async () => {
      const status = {
        runId: "evr_1",
        status: "running" as const,
        itemCount: 5,
        completedCount: 2,
        failedCount: 0,
        avgScore: null,
        failureReason: null,
      };
      mockInvoke.mockResolvedValue(status);

      const result = await getEvalRunStatusAction(
        base({ runPublicId: "evr_1" }),
      );

      expect(result).toEqual({ ok: true, status });
      expect(mockInvoke).toHaveBeenCalledWith(
        "get_eval_status",
        { runPublicId: "evr_1" },
        expect.objectContaining({ orgId: "org-1" }),
      );
      expect(mockInvoke.mock.calls[0]).toHaveLength(3);
    });

    it("ALLOWS a viewer to poll status", async () => {
      dbState.wsRoleRows = [{ role: "viewer" }];
      mockInvoke.mockResolvedValue({
        runId: "evr_1",
        status: "completed",
        itemCount: 5,
        completedCount: 5,
        failedCount: 0,
        avgScore: 0.9,
        failureReason: null,
      });

      const result = await getEvalRunStatusAction(
        base({ runPublicId: "evr_1" }),
      );

      expect(result.ok).toBe(true);
    });

    it("rejects an empty runPublicId before invoking", async () => {
      const result = await getEvalRunStatusAction(base({ runPublicId: "" }));

      expect(result.ok).toBe(false);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });
});
