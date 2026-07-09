// bootstrap.test.ts — unit tests for bootstrapIAMRuntime() (OXA-1524).
//
// Tests:
//   - Wires checkIAM into setKernelIAMRuntime() with enforced=true always
//   - The IAM adapter correctly flattens ResolveResult → { outcome, reason?, principal }

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  setKernelIAMRuntime: vi.fn<(fn: (args: unknown) => Promise<unknown>, enforced: boolean) => void>(),
  checkIAM: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  setKernelIAMRuntime: mocks.setKernelIAMRuntime,
}));

vi.mock("./check-iam", () => ({ checkIAM: mocks.checkIAM }));

import { bootstrapIAMRuntime } from "./bootstrap";

describe("bootstrapIAMRuntime()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls setKernelIAMRuntime with the IAM check adapter and enforced=true", () => {
    bootstrapIAMRuntime();

    expect(mocks.setKernelIAMRuntime).toHaveBeenCalledTimes(1);
    const [kernelFn, enforced] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    expect(typeof kernelFn).toBe("function");
    expect(enforced).toBe(true);
  });

  it("is idempotent — calling twice does not throw", () => {
    expect(() => {
      bootstrapIAMRuntime();
      bootstrapIAMRuntime();
    }).not.toThrow();
    expect(mocks.setKernelIAMRuntime).toHaveBeenCalledTimes(2);
  });

  it("IAM kernel adapter flattens allow ResolveResult to { outcome, principal }", async () => {
    const PRINCIPAL = { id: "prn_1", kind: "human" as const, orgId: "org_1", workspaceId: null };
    const TRACE = {
      steps: [{ rule: "tier_gate", description: "allow", decided: true, outcome: "allow" as const }],
      decidedBy: { rule: "tier_gate", description: "allow", decided: true, outcome: "allow" as const },
    };
    mocks.checkIAM.mockResolvedValue({ result: { outcome: "allow", trace: TRACE }, principal: PRINCIPAL });

    bootstrapIAMRuntime();
    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    const result = await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "send_message",
      ctx: { orgId: "org_1", workspaceId: "ws_1", userId: "usr_1", apiKeyId: null, requestId: "req_1", surface: "api", messageId: null },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect((result as Record<string, unknown>)["outcome"]).toBe("allow");
    expect((result as Record<string, unknown>)["principal"]).toEqual(PRINCIPAL);
    expect((result as Record<string, unknown>)["reason"]).toBeUndefined();
  });

  it("IAM kernel adapter propagates reason for deny results", async () => {
    const TRACE = {
      steps: [{ rule: "8:default", description: "deny", decided: true, outcome: "deny" as const }],
      decidedBy: { rule: "8:default", description: "deny", decided: true, outcome: "deny" as const },
    };
    mocks.checkIAM.mockResolvedValue({ result: { outcome: "deny", reason: "no_grant", trace: TRACE }, principal: null });

    bootstrapIAMRuntime();
    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    const result = await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "send_message",
      ctx: { orgId: "org_1", workspaceId: "ws_1", userId: null, apiKeyId: null, requestId: "req_1", surface: "api", messageId: null },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect((result as Record<string, unknown>)["outcome"]).toBe("deny");
    expect((result as Record<string, unknown>)["reason"]).toBe("no_grant");
  });
});
