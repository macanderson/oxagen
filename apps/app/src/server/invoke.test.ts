import type { agentApprovalResolve } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { getScope } from "@oxagen/tenancy";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ContractOutputMismatch, ToolNotRegistered } from "./errors";
import { InviteeCtx } from "./viewer";
import { unsafeMint } from "./viewer.testing";

const { invokeMock, getCapabilityMock, registry } = vi.hoisted(() => ({
  registry: { loaded: false },
  invokeMock:
    vi.fn<
      (
        name: string,
        input: unknown,
        ctx: Record<string, unknown>,
        opts?: unknown,
      ) => Promise<unknown>
    >(),
  getCapabilityMock: vi.fn<(name: string) => unknown>(),
}));

vi.mock("@oxagen/handlers/register", () => {
  registry.loaded = true;
  return {};
});
vi.mock("@oxagen/oxagen", () => ({
  invoke: invokeMock,
  getCapability: getCapabilityMock,
}));

import { invokeTool, type ToolContract } from "./invoke";

// Compile-time proof that a real registered contract (zod 3.25, from
// @oxagen/oxagen) fits the structural seam the app (zod 4) calls through.
type RealContractFits = typeof agentApprovalResolve extends ToolContract<
  infer _I,
  infer _O
>
  ? true
  : false;
const realContractFits: RealContractFits = true;

const resolveApproval = {
  name: "resolve_approval",
  input: z.object({
    approvalId: z.string().min(1),
    decision: z.enum(["approved", "denied"]),
  }),
  output: z.object({ id: z.string(), status: z.enum(["approved", "denied"]) }),
};

const viewer = unsafeMint(InviteeCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "6f1d2c3a-5b4e-4d10-8a01-00000000ac01",
  invitationId: "0192f1c4-0000-7000-8000-0000000000aa",
});
/** An invitee holds no workspace: the invoke runs under the org-only sentinel. */
const scope = {
  orgId: viewer.orgId,
  workspaceId: "00000000-0000-0000-0000-000000000000",
};
const input = { approvalId: "apr_1", decision: "approved" as const };

beforeEach(() => {
  invokeMock.mockReset();
  getCapabilityMock.mockReset();
  getCapabilityMock.mockReturnValue({ name: "resolve_approval" });
});

describe("invokeTool", () => {
  it("a real contract type fits the seam", () => {
    expect(realContractFits).toBe(true);
  });

  it("loads the handler registry before the first kernel call", async () => {
    invokeMock.mockImplementation(() => {
      expect(registry.loaded).toBe(true);
      return Promise.resolve({ id: "apr_1", status: "approved" });
    });
    await invokeTool(viewer, resolveApproval, input);
    expect(invokeMock).toHaveBeenCalledOnce();
  });

  it("invokes the kernel inside the invitation's organization scope and returns the parsed output", async () => {
    let scopeSeen: unknown = null;
    invokeMock.mockImplementation(() => {
      scopeSeen = getScope();
      return Promise.resolve({ id: "apr_1", status: "approved", extra: 1 });
    });
    const out = await invokeTool(viewer, resolveApproval, input);
    // Parsed, not cast: the unknown key is stripped by the contract schema.
    expect(out).toEqual({ id: "apr_1", status: "approved" });
    expect(scopeSeen).toMatchObject(scope);
    expect(invokeMock).toHaveBeenCalledOnce();
    const [name, sentInput, ctx, opts] = invokeMock.mock.calls[0] ?? [];
    expect(name).toBe("resolve_approval");
    expect(sentInput).toBe(input);
    expect(ctx).toMatchObject({
      ...scope,
      userId: viewer.userId,
      apiKeyId: null,
      surface: "app",
      messageId: null,
    });
    expect(ctx?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // No surface claim: api-only contracts must not be surface-denied from the app.
    expect(opts).toBeUndefined();
  });

  it("throws ContractOutputMismatch when the output does not match the contract, and never returns it", async () => {
    invokeMock.mockResolvedValue({ id: 42, status: "maybe" });
    const err = await invokeTool(viewer, resolveApproval, input).catch(
      (e: unknown) => e,
    );
    assert(err instanceof ContractOutputMismatch);
    expect(err.tool).toBe("resolve_approval");
    expect(err.issues.length).toBeGreaterThan(0);
  });

  it("throws ContractOutputMismatch for a missing result", async () => {
    invokeMock.mockResolvedValue(undefined);
    await expect(invokeTool(viewer, resolveApproval, input)).rejects.toThrow(
      ContractOutputMismatch,
    );
  });

  it("refuses a contract the kernel has not registered, before invoking", async () => {
    getCapabilityMock.mockReturnValue(undefined);
    await expect(invokeTool(viewer, resolveApproval, input)).rejects.toThrow(
      ToolNotRegistered,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("propagates a kernel error untouched", async () => {
    const denied = new Error("denied");
    denied.name = "CapabilityError";
    invokeMock.mockRejectedValue(denied);
    await expect(invokeTool(viewer, resolveApproval, input)).rejects.toBe(
      denied,
    );
  });
});
