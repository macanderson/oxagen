/**
 * actions.test.ts — unit tests for cancelFanoutAction (validation + gating).
 * Mocking strategy mirrors workbench/sandboxes/actions.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { resolveWorkbenchScope, invoke } = vi.hoisted(() => ({
  resolveWorkbenchScope: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@oxagen/handlers/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/workbench/scope", () => ({ resolveWorkbenchScope }));
vi.mock("@oxagen/oxagen", () => ({ invoke }));

import { cancelFanoutAction } from "./actions";

const SCOPE = { orgSlug: "acme", workspaceSlug: "eng" };
const CTX = {
  orgId: "o1",
  workspaceId: "w1",
  userId: "u1",
  apiKeyId: null,
  requestId: "r1",
  surface: "app" as const,
  messageId: null,
};

function scope(canManage: boolean) {
  return { ctx: CTX, canManage, session: {}, org: {}, ws: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cancelFanoutAction", () => {
  it("rejects invalid input (missing fanoutId)", async () => {
    const res = await cancelFanoutAction({ ...SCOPE, fanoutId: "" });
    expect(res.ok).toBe(false);
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a missing orgSlug/workspaceSlug", async () => {
    const res = await cancelFanoutAction({
      orgSlug: "",
      workspaceSlug: "eng",
      fanoutId: "fo_1",
    });
    expect(res.ok).toBe(false);
    expect(resolveWorkbenchScope).not.toHaveBeenCalled();
  });

  it("gates non-managers", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(false));
    const res = await cancelFanoutAction({ ...SCOPE, fanoutId: "fo_1" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/owners and admins/i);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels on success and passes surface agent", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    invoke.mockResolvedValue({
      fanoutId: "fo_1",
      status: "timed_out",
      cancelledChildren: 3,
    });
    const res = await cancelFanoutAction({ ...SCOPE, fanoutId: "fo_1" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fanout.cancelledChildren).toBe(3);
      expect(res.fanout.status).toBe("timed_out");
    }
    expect(invoke).toHaveBeenCalledTimes(1);
    const [name, input, ctx, opts] = invoke.mock.calls[0] as [
      string,
      { fanoutId: string },
      unknown,
      { surface: string },
    ];
    expect(name).toBe("cancel_subagent");
    expect(input).toEqual({ fanoutId: "fo_1" });
    expect(ctx).toBe(CTX);
    expect(opts).toEqual({ surface: "agent" });
  });

  it("surfaces a handler failure", async () => {
    resolveWorkbenchScope.mockResolvedValue(scope(true));
    invoke.mockRejectedValue(new Error("fanout not found"));
    const res = await cancelFanoutAction({ ...SCOPE, fanoutId: "fo_missing" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("fanout not found");
  });
});
