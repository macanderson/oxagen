// bootstrap.test.ts — unit tests for bootstrapIAMRuntime() (OXA-1524).
//
// Tests:
//   - Wires checkIAM into setKernelIAMRuntime()
//   - The enforcement flag is read from IAM_ENFORCEMENT_ENABLED env var
//   - The IAM adapter correctly flattens ResolveResult → { outcome, reason?, principal }

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

type EnvResult = { IAM_ENFORCEMENT_ENABLED: boolean };

const mocks = vi.hoisted(() => ({
  setKernelIAMRuntime: vi.fn<(fn: (args: unknown) => Promise<unknown>, enforced: boolean) => void>(),
  checkIAM: vi.fn(),
  requireEnv: vi.fn<() => EnvResult>(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  setKernelIAMRuntime: mocks.setKernelIAMRuntime,
}));

vi.mock("./check-iam", () => ({ checkIAM: mocks.checkIAM }));

vi.mock("@oxagen/config/env", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@oxagen/config/env")>();
  return {
    ...orig,
    requireEnv: mocks.requireEnv,
  };
});

import { bootstrapIAMRuntime } from "./bootstrap";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("bootstrapIAMRuntime()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireEnv.mockReturnValue({ IAM_ENFORCEMENT_ENABLED: true });
  });

  it("calls setKernelIAMRuntime with the IAM check adapter and enforcement flag", () => {
    mocks.requireEnv.mockReturnValue({ IAM_ENFORCEMENT_ENABLED: true });
    bootstrapIAMRuntime();

    expect(mocks.setKernelIAMRuntime).toHaveBeenCalledTimes(1);
    const [kernelFn, enforced] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    expect(typeof kernelFn).toBe("function");
    expect(enforced).toBe(true);
  });

  it("passes enforced=false when IAM_ENFORCEMENT_ENABLED is false", () => {
    mocks.requireEnv.mockReturnValue({ IAM_ENFORCEMENT_ENABLED: false });
    bootstrapIAMRuntime();

    const [, enforced] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    expect(enforced).toBe(false);
  });

  it("is idempotent — calling twice does not throw", () => {
    mocks.requireEnv.mockReturnValue({ IAM_ENFORCEMENT_ENABLED: true });
    expect(() => {
      bootstrapIAMRuntime();
      bootstrapIAMRuntime();
    }).not.toThrow();
    expect(mocks.setKernelIAMRuntime).toHaveBeenCalledTimes(2);
  });

  it("IAM kernel adapter flattens ResolveResult to { outcome, reason?, principal }", async () => {
    const PRINCIPAL = { id: "prn_1", kind: "human" as const, orgId: "org_1", workspaceId: null };
    const TRACE = {
      steps: [{ rule: "7:role_grant", description: "allow", decided: true, outcome: "allow" as const }],
      decidedBy: { rule: "7:role_grant", description: "allow", decided: true, outcome: "allow" as const },
    };

    mocks.checkIAM.mockResolvedValue({
      result: { outcome: "allow", trace: TRACE },
      principal: PRINCIPAL,
    });
    mocks.requireEnv.mockReturnValue({ IAM_ENFORCEMENT_ENABLED: true });

    bootstrapIAMRuntime();

    // Extract the adapter function that was passed to setKernelIAMRuntime.
    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    const result = await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "chat.message.send",
      ctx: {
        orgId: "org_1",
        workspaceId: "ws_1",
        userId: "usr_1",
        apiKeyId: null,
        requestId: "req_1",
        surface: "api",
        messageId: null,
      },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect((result as Record<string, unknown>)["outcome"]).toBe("allow");
    expect((result as Record<string, unknown>)["principal"]).toEqual(PRINCIPAL);
    // No 'reason' on allow results.
    expect((result as Record<string, unknown>)["reason"]).toBeUndefined();
  });

  it("IAM kernel adapter propagates reason for deny results", async () => {
    const TRACE = {
      steps: [{ rule: "8:default", description: "deny", decided: true, outcome: "deny" as const }],
      decidedBy: { rule: "8:default", description: "deny", decided: true, outcome: "deny" as const },
    };

    mocks.checkIAM.mockResolvedValue({
      result: { outcome: "deny", reason: "no_grant", trace: TRACE },
      principal: null,
    });
    mocks.requireEnv.mockReturnValue({ IAM_ENFORCEMENT_ENABLED: true });

    bootstrapIAMRuntime();

    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    const result = await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "chat.message.send",
      ctx: {
        orgId: "org_1",
        workspaceId: "ws_1",
        userId: null,
        apiKeyId: null,
        requestId: "req_1",
        surface: "api",
        messageId: null,
      },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect((result as Record<string, unknown>)["outcome"]).toBe("deny");
    expect((result as Record<string, unknown>)["reason"]).toBe("no_grant");
  });
});
