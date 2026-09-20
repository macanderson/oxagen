import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDecisionRulesGate,
  ruleSetSchema,
  type RuleSet,
} from "@oxagen/rules";
import {
  setSecurityEventEmitter,
  clearSecurityEventEmitter,
  setKernelIAMRuntime,
  clearKernelIAMRuntime,
  authorizeExternalCapability,
  setDecisionRulesGate,
  clearDecisionRulesGate,
  enforceExternalDecisionRules,
} from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "../types";

const mocks = vi.hoisted(() => ({ create: vi.fn(), wait: vi.fn() }));
vi.mock("./approval", () => ({
  createApprovalRequest: mocks.create,
  waitForApproval: mocks.wait,
}));
import { externalDecisionCheck } from "./external-tool-rules";

const ctx: CapabilityContext = {
  orgId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "10000000-0000-4000-8000-000000000002",
  userId: "10000000-0000-4000-8000-000000000003",
  messageId: "10000000-0000-4000-8000-000000000004",
  apiKeyId: null,
  requestId: "external-test",
  surface: "app",
};
const name = "mcp.10000000-0000-4000-8000-000000000005.charge_card";
let rules: RuleSet;
const autoApprove = vi.fn();
function gate() {
  setDecisionRulesGate(
    createDecisionRulesGate({ loadRuleSet: async () => rules, autoApprove }),
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  rules = ruleSetSchema.parse({
    schema: "oxagen.decision-rules.v2",
    rules: [],
  });
  mocks.create.mockResolvedValue({ approvalId: "approval-1" });
  mocks.wait.mockResolvedValue({ resolution: "approved" });
  gate();
});
afterEach(() => {
  clearSecurityEventEmitter();
  clearKernelIAMRuntime();
  clearDecisionRulesGate();
  vi.useRealTimers();
});
function rule(effect: "deny" | "require_approval") {
  rules.rules = [
    {
      id: "external-rule",
      description: "Operator external rule",
      capability: name,
      effect,
    },
  ];
}
const check = (onApprovalRequired = vi.fn(), input: unknown = { amount: 5 }) =>
  externalDecisionCheck({ name, input, ctx, onApprovalRequired });

describe("external decision admission", () => {
  it("refuses a denied call before its transport executes", async () => {
    rule("deny");
    const transport = vi.fn();
    await expect(
      (async () => {
        await check()();
        transport();
      })(),
    ).rejects.toMatchObject({ code: "decision_rule_denied" });
    expect(transport).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("requires exact human approval and never calls auto-approval", async () => {
    rule("require_approval");
    autoApprove.mockResolvedValue({ ok: true, commit: vi.fn() });
    const event = vi.fn();
    const admit = check(event);
    await admit();
    await admit();
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: name,
        inputPreview: { amount: 5 },
      }),
    );
    expect(mocks.wait).toHaveBeenCalledWith("approval-1");
    expect(autoApprove).not.toHaveBeenCalled();
  });
  it("gives concurrent inputs distinct approval identities", async () => {
    rule("require_approval");
    await Promise.all([
      check(vi.fn(), { amount: 5 })(),
      check(vi.fn(), { amount: 500 })(),
    ]);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const first = mocks.create.mock.calls[0]?.[0];
    const second = mocks.create.mock.calls[1]?.[0];
    expect(first.toolCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.toolCallId).not.toBe(second.toolCallId);
    expect(first.inputPreview).not.toEqual(second.inputPreview);
  });
  it("refuses a new approval at the final non-interactive boundary", async () => {
    const admit = check();
    await admit();
    rule("require_approval");
    await expect(admit({ interactive: false })).rejects.toMatchObject({
      code: "decision_rule_approval_required",
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each(["denied", "expired"])(
    "does not release a %s human decision",
    async (resolution) => {
      rule("require_approval");
      mocks.wait.mockResolvedValue({ resolution });
      await expect(check()()).rejects.toMatchObject({
        code: "decision_rule_approval_required",
      });
    },
  );
  it("refuses a new deny published during the approval wait", async () => {
    rule("require_approval");
    mocks.wait.mockImplementation(async () => {
      rule("deny");
      return { resolution: "approved" };
    });
    await expect(check()()).rejects.toMatchObject({
      code: "decision_rule_denied",
    });
  });
  it("does not transfer approval to a changed input or rule document", async () => {
    rule("require_approval");
    const input = { amount: 5 };
    mocks.wait.mockImplementation(async () => {
      input.amount = 500;
      return { resolution: "approved" };
    });
    await expect(check(vi.fn(), input)()).rejects.toMatchObject({
      code: "decision_rule_approval_required",
    });
  });
  it("re-reads rules after another consent wait", async () => {
    const admit = check();
    await admit();
    rule("deny");
    await expect(admit()).rejects.toMatchObject({
      code: "decision_rule_denied",
    });
  });
  it("refuses an approval-required call with no interactive callback", async () => {
    rule("require_approval");
    await expect(
      externalDecisionCheck({ name, input: {}, ctx })(),
    ).rejects.toMatchObject({ code: "decision_rule_approval_required" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("fails closed when no decision runtime was installed", async () => {
    clearDecisionRulesGate();
    await expect(check()()).rejects.toMatchObject({
      code: "external_rules_unavailable",
    });
  });
  it("does not wait when the surface parks its approval card", async () => {
    rule("require_approval");
    const parked = new Error("parked");
    await expect(
      check(
        vi.fn(() => {
          throw parked;
        }),
      )(),
    ).rejects.toBe(parked);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.wait).not.toHaveBeenCalled();
  });
  it("reports infrastructure failures as security errors", async () => {
    const emit = vi.fn();
    setSecurityEventEmitter(emit);
    clearDecisionRulesGate();
    await expect(check()()).rejects.toMatchObject({
      code: "external_rules_unavailable",
    });
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "external_rules_unavailable",
      }),
    );
    setDecisionRulesGate(
      createDecisionRulesGate({
        loadRuleSet: async () => {
          throw new Error("offline");
        },
      }),
    );
    await expect(check()()).rejects.toThrow("offline");
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "external_decision_refused",
      }),
    );
  });
  it("fails closed on a rule loader failure", async () => {
    setDecisionRulesGate(
      createDecisionRulesGate({
        loadRuleSet: async () => {
          throw new Error("database unavailable");
        },
      }),
    );
    await expect(check()()).rejects.toThrow("database unavailable");
  });
  it("refuses missing facts even when requires_facts was omitted", async () => {
    rules.rules = [
      {
        id: "cost",
        description: "Cost ceiling",
        capability: name,
        effect: "deny",
        when: { fact: "facts.cost", op: "gt", value: 10 },
      },
    ];
    await expect(check()()).rejects.toMatchObject({
      code: "external_tool_authority_unavailable",
    });
  });
  it("refuses an agent principal without declared mandate measures", async () => {
    const agentCtx = {
      ...ctx,
      agentRun: {
        principalKind: "agent",
        agentPrincipal: { kind: "agent", id: "agent-1" },
      },
    } as CapabilityContext;
    await expect(
      enforceExternalDecisionRules(name, {}, agentCtx),
    ).rejects.toMatchObject({ code: "external_tool_authority_unavailable" });
  });
  it("preserves IAM's agent identity when no run context is present", async () => {
    const principal = {
      id: "agent-id",
      kind: "agent" as const,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    };
    setKernelIAMRuntime(async () => ({ outcome: "allow", principal }), true);
    const authorization = await authorizeExternalCapability(name, ctx, "deny");
    expect(authorization.principal).toEqual(principal);
    await expect(
      enforceExternalDecisionRules(name, {}, ctx, {
        principal: authorization.principal,
      }),
    ).rejects.toMatchObject({ code: "external_tool_authority_unavailable" });
  });
  it("emits allow and deny security events with tenant and tool identity", async () => {
    const emit = vi.fn();
    setSecurityEventEmitter(emit);
    await check()();
    rule("deny");
    await expect(check()()).rejects.toMatchObject({
      code: "decision_rule_denied",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: name,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        outcome: "allow",
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: name,
        outcome: "deny",
        errorCode: "decision_rule_denied",
      }),
    );
  });
  it("does not retain an expired approval across a later consent wait", async () => {
    vi.useFakeTimers();
    rule("require_approval");
    const admit = check();
    await admit();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    mocks.wait.mockResolvedValue({ resolution: "denied" });
    await expect(admit()).rejects.toMatchObject({
      code: "decision_rule_approval_required",
    });
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });
  it.each([
    name,
    "mcp.*",
    "mcp.server.*",
    "file-mcp.Local_Server.write-file",
    "file-mcp.*",
  ])("accepts canonical identity pattern %s", (capability) => {
    expect(
      ruleSetSchema.safeParse({
        schema: "oxagen.decision-rules.v1",
        rules: [
          { id: "rule", description: "External", capability, effect: "deny" },
        ],
      }).success,
    ).toBe(true);
  });
});
