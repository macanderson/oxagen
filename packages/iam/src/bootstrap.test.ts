// bootstrap.test.ts — unit tests for bootstrapIAMRuntime().
//
// Tests:
//   - Wires checkIAM into setKernelIAMRuntime() with enforced=true always
//   - The IAM adapter correctly flattens ResolveResult → { outcome, reason?, principal }

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  setKernelIAMRuntime:
    vi.fn<
      (fn: (args: unknown) => Promise<unknown>, enforced: boolean) => void
    >(),
  setKernelAccessRequestCreator:
    vi.fn<(fn: (args: unknown) => Promise<string | null>) => void>(),
  checkIAM: vi.fn(),
  createAccessRequest: vi.fn(),
  machineKeyDenial: vi.fn(async () => undefined as string | undefined),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  setKernelIAMRuntime: mocks.setKernelIAMRuntime,
  setKernelAccessRequestCreator: mocks.setKernelAccessRequestCreator,
}));

vi.mock("./check-iam", () => ({ checkIAM: mocks.checkIAM }));
vi.mock("./machine-key-scope", () => ({
  machineKeyDenial: mocks.machineKeyDenial,
}));
vi.mock("./access-request", () => ({
  createAccessRequest: mocks.createAccessRequest,
}));

import { bootstrapIAMRuntime } from "./bootstrap";

describe("bootstrapIAMRuntime()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.machineKeyDenial.mockResolvedValue(undefined);
  });

  it("calls setKernelIAMRuntime with the IAM check adapter and enforced=true", () => {
    bootstrapIAMRuntime();

    expect(mocks.setKernelIAMRuntime).toHaveBeenCalledTimes(1);
    const [kernelFn, enforced] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    expect(typeof kernelFn).toBe("function");
    expect(enforced).toBe(true);
  });

  it("registers the JIT access-request creator that delegates to createAccessRequest", async () => {
    mocks.createAccessRequest.mockResolvedValue("arq_wired_1");

    bootstrapIAMRuntime();

    expect(mocks.setKernelAccessRequestCreator).toHaveBeenCalledTimes(1);
    const [creatorFn] = mocks.setKernelAccessRequestCreator.mock.calls[0] ?? [];
    expect(typeof creatorFn).toBe("function");

    const args = {
      capability: "send_message",
      ctx: {
        orgId: "org_1",
        workspaceId: "ws_1",
        userId: "usr_1",
        apiKeyId: null,
        requestId: "req_1",
        surface: "api",
        messageId: null,
      },
      principal: {
        id: "prn_1",
        kind: "human" as const,
        orgId: "org_1",
        workspaceId: "ws_1",
      },
    };
    const out = await (creatorFn as (a: unknown) => Promise<string | null>)(
      args,
    );

    expect(mocks.createAccessRequest).toHaveBeenCalledWith(args);
    expect(out).toBe("arq_wired_1");
  });

  it("is idempotent — calling twice does not throw", () => {
    expect(() => {
      bootstrapIAMRuntime();
      bootstrapIAMRuntime();
    }).not.toThrow();
    expect(mocks.setKernelIAMRuntime).toHaveBeenCalledTimes(2);
  });

  it("IAM kernel adapter flattens allow ResolveResult to { outcome, principal }", async () => {
    const PRINCIPAL = {
      id: "prn_1",
      kind: "human" as const,
      orgId: "org_1",
      workspaceId: null,
    };
    const TRACE = {
      steps: [
        {
          rule: "tier_gate",
          description: "allow",
          decided: true,
          outcome: "allow" as const,
        },
      ],
      decidedBy: {
        rule: "tier_gate",
        description: "allow",
        decided: true,
        outcome: "allow" as const,
      },
    };
    mocks.checkIAM.mockResolvedValue({
      result: { outcome: "allow", trace: TRACE },
      principal: PRINCIPAL,
    });

    bootstrapIAMRuntime();
    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    const result = await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "send_message",
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
    expect((result as Record<string, unknown>)["reason"]).toBeUndefined();
  });

  it("IAM kernel adapter propagates reason for deny results", async () => {
    const TRACE = {
      steps: [
        {
          rule: "8:default",
          description: "deny",
          decided: true,
          outcome: "deny" as const,
        },
      ],
      decidedBy: {
        rule: "8:default",
        description: "deny",
        decided: true,
        outcome: "deny" as const,
      },
    };
    mocks.checkIAM.mockResolvedValue({
      result: { outcome: "deny", reason: "no_grant", trace: TRACE },
      principal: null,
    });

    bootstrapIAMRuntime();
    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    const result = await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "send_message",
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

  it("hands the machine-key gate the person the surface resolved", async () => {
    // The gate exempts a CLI session key from the machine mandate only when a
    // person came with it. It cannot ask the surface itself, so this adapter
    // is the one place that knows — and dropping ctx.userId here would hand
    // back the exemption the MCP surface used to get for free.
    mocks.checkIAM.mockResolvedValue({
      result: { outcome: "allow", trace: { steps: [], decidedBy: undefined } },
      principal: null,
    });

    bootstrapIAMRuntime();
    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "set_model_credential",
      ctx: {
        orgId: "org_1",
        workspaceId: "ws_1",
        userId: "usr_alice",
        apiKeyId: "aky_cli",
        requestId: "req_1",
        surface: "mcp",
        messageId: null,
      },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(mocks.machineKeyDenial).toHaveBeenCalledWith({
      orgId: "org_1",
      apiKeyId: "aky_cli",
      userId: "usr_alice",
      capabilityName: "set_model_credential",
      // Carried for every caller and read back only for a `tacho_gateway_v1`
      // key (#3221). Null here: this context is a CLI session, not a gateway,
      // and the adapter passes what the surface resolved rather than omitting
      // the field — so the gate sees "no chain" rather than "not asked".
      gatewaySessionUuid: null,
      gatewayChainGenesisHash: null,
    });
  });

  it("passes the gateway chain the MCP surface resolved, when there is one", async () => {
    // The other half of the same rule: what the surface read off the request
    // reaches the gate unchanged. `machineKeyDenial` decides whether it means
    // anything, by the key's scope purpose; this adapter only has to not lose
    // it.
    mocks.checkIAM.mockResolvedValue({
      result: { outcome: "allow", trace: { steps: [], decidedBy: undefined } },
      principal: null,
    });

    bootstrapIAMRuntime();
    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "query_ontology",
      ctx: {
        orgId: "org_1",
        workspaceId: "ws_1",
        userId: null,
        apiKeyId: "aky_gw",
        requestId: "req_2",
        surface: "mcp",
        messageId: null,
        gatewaySessionUuid: "tachod-abc",
        gatewayChainGenesisHash: `sha256:${"a".repeat(64)}`,
      },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect(mocks.machineKeyDenial).toHaveBeenCalledWith({
      orgId: "org_1",
      apiKeyId: "aky_gw",
      userId: null,
      capabilityName: "query_ontology",
      gatewaySessionUuid: "tachod-abc",
      gatewayChainGenesisHash: `sha256:${"a".repeat(64)}`,
    });
  });

  it("denies with the gate's reason and never reaches checkIAM", async () => {
    mocks.machineKeyDenial.mockResolvedValue("Forbidden: outside the mandate");

    bootstrapIAMRuntime();
    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    const result = await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "set_model_credential",
      ctx: {
        orgId: "org_1",
        workspaceId: "ws_1",
        userId: null,
        apiKeyId: "aky_cli",
        requestId: "req_1",
        surface: "mcp",
        messageId: null,
      },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect((result as Record<string, unknown>)["outcome"]).toBe("deny");
    expect((result as Record<string, unknown>)["reason"]).toBe(
      "Forbidden: outside the mandate",
    );
    expect(mocks.checkIAM).not.toHaveBeenCalled();
    // The machine-key gate is the rule that decided (#3841).
    expect((result as Record<string, unknown>)["decidedBy"]).toBe(
      "machine_key_scope",
    );
  });

  // #3841: the adapter dropped `trace.decidedBy`, so a denied page could never
  // name the rule that refused it.
  it.each([
    ["deny", "7:role_grant"],
    ["pending_approval", "5:workspace_require_approval"],
    ["allow", "tier_gate"],
  ] as const)(
    "forwards the rule id that decided a %s, and not its description",
    async (outcome, rule) => {
      const step = {
        rule,
        description: "role 0192d4a8-7c1e-7a00-8000-0000000000aa grants it",
        decided: true,
        outcome,
      };
      mocks.checkIAM.mockResolvedValue({
        result: {
          outcome,
          ...(outcome === "deny" ? { reason: "no_grant" } : {}),
          trace: { steps: [step], decidedBy: step },
        },
        principal: null,
      });

      bootstrapIAMRuntime();
      const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
      const result = await (kernelFn as (args: unknown) => Promise<unknown>)({
        capability: "list_runs",
        ctx: {
          orgId: "org_1",
          workspaceId: "ws_1",
          userId: "usr_1",
          apiKeyId: null,
          requestId: "req_1",
          surface: "app",
          messageId: null,
        },
        defaultEffect: "deny",
        rawInputJson: "{}",
      });

      expect((result as Record<string, unknown>)["decidedBy"]).toBe(rule);
      expect(JSON.stringify(result)).not.toContain("0192d4a8");
    },
  );

  it("reads null when the trace names no deciding step", async () => {
    mocks.checkIAM.mockResolvedValue({
      result: { outcome: "allow", trace: { steps: [], decidedBy: undefined } },
      principal: null,
    });

    bootstrapIAMRuntime();
    const [kernelFn] = mocks.setKernelIAMRuntime.mock.calls[0] ?? [];
    const result = await (kernelFn as (args: unknown) => Promise<unknown>)({
      capability: "list_runs",
      ctx: {
        orgId: "org_1",
        workspaceId: "ws_1",
        userId: "usr_1",
        apiKeyId: null,
        requestId: "req_1",
        surface: "app",
        messageId: null,
      },
      defaultEffect: "deny",
      rawInputJson: "{}",
    });

    expect((result as Record<string, unknown>)["decidedBy"]).toBeNull();
  });
});
