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

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  wait: vi.fn(),
  external: vi.fn(),
}));
vi.mock("./approval", () => ({
  createApprovalRequest: mocks.create,
  waitForApproval: mocks.wait,
}));
vi.mock("./external-approval", () => ({ externalApproval: mocks.external }));
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
  mocks.create.mockResolvedValue({
    approvalId: "approval-1",
    approvalPublicId: "apr_2",
  });
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
  it.each([
    ["denied", "decision_rule_denied"],
    ["expired", "decision_rule_approval_required"],
  ])("does not release a %s human decision", async (resolution, code) => {
    // Neither releases the call. A person's no is a denial that names the
    // rule; an expiry is still a request nobody answered.
    rule("require_approval");
    mocks.wait.mockResolvedValue({ resolution });
    await expect(check()()).rejects.toMatchObject({ code });
  });
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
  it("names the approval it waits on by its public id", async () => {
    rule("require_approval");
    const event = vi.fn();
    await check(event)();
    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        approvalPublicId: "apr_2",
      }),
    );
    expect(mocks.wait).toHaveBeenCalledWith("approval-1");
  });
  it("names the parked approval by its public id", async () => {
    rule("require_approval");
    const parked = new Error("parked");
    mocks.external.mockResolvedValue({
      approvalId: "approval-1",
      approvalPublicId: "apr_1",
      expiresAt: new Date(Date.now() + 60_000),
      status: "pending",
    });
    const event = vi.fn(() => {
      throw parked;
    });
    await expect(
      externalDecisionCheck({
        name,
        input: { amount: 5 },
        ctx,
        approvalMode: "park",
        onApprovalRequired: event,
      })(),
    ).rejects.toBe(parked);
    expect(event).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        approvalPublicId: "apr_1",
      }),
    );
  });
  it("recovers parked proof in a rebuilt checker and consumes it once", async () => {
    rule("require_approval");
    const parked = new Error("parked");
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.external.mockResolvedValue({
      approvalId: "approval-1",
      expiresAt,
      status: "pending",
    });
    const event = vi.fn(() => {
      throw parked;
    });
    const rebuild = () =>
      externalDecisionCheck({
        name,
        input: { amount: 5 },
        ctx,
        approvalMode: "park",
        onApprovalRequired: event,
      });
    await expect(rebuild()()).rejects.toBe(parked);
    const originalDigest = mocks.external.mock.calls[0]?.[0].approvalDigest;
    mocks.external.mockResolvedValueOnce({
      approvalId: "approval-1",
      expiresAt,
      status: "approved",
    });
    const retry = rebuild();
    await retry();
    await retry({ interactive: false });
    expect(mocks.external.mock.calls[1]?.[0].approvalDigest).toBe(
      originalDigest,
    );
    expect(mocks.external).toHaveBeenCalledTimes(2);
    expect(event).toHaveBeenCalledOnce();
    expect(mocks.wait).not.toHaveBeenCalled();
    // A person's no is a denial in the same shape a deny rule produces,
    // not a second request for the approval they just refused.
    mocks.external.mockResolvedValue({
      approvalId: "approval-1",
      expiresAt,
      status: "refused",
    });
    await expect(rebuild()()).rejects.toMatchObject({
      code: "decision_rule_denied",
      verdict: { effect: "deny", ruleId: "external-rule" },
    });
    // The refusal is final for this invocation: no card is re-raised.
    expect(event).toHaveBeenCalledOnce();
  });
  it("turns a person's refusal in the wait flow into a denial that names the rule", async () => {
    rule("require_approval");
    mocks.wait.mockResolvedValueOnce({ resolution: "denied", note: null });
    const err: unknown = await check()().catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "decision_rule_denied",
      verdict: { effect: "deny", ruleId: "external-rule" },
    });
    expect((err as Error).message).toMatch(/refused by decision rule/);
    expect((err as Error).message).toMatch(/a person refused/);
  });
  it("keeps an expired wait as approval required, since nobody answered", async () => {
    rule("require_approval");
    mocks.wait.mockResolvedValueOnce({ resolution: "expired", note: null });
    await expect(check()()).rejects.toMatchObject({
      code: "decision_rule_approval_required",
    });
  });
  it("requires a different persisted proof after the input or rules change", async () => {
    rule("require_approval");
    const parked = new Error("parked");
    mocks.external.mockResolvedValue({
      approvalId: "approval-1",
      expiresAt: new Date(Date.now() + 60_000),
      status: "pending",
    });
    const input = { amount: 5 };
    const retry = () =>
      externalDecisionCheck({
        name,
        input,
        ctx,
        approvalMode: "park",
        onApprovalRequired: () => {
          throw parked;
        },
      })();
    await expect(retry()).rejects.toBe(parked);
    input.amount = 10;
    await expect(retry()).rejects.toBe(parked);
    rules.rules[0]!.description = "Changed rule";
    await expect(retry()).rejects.toBe(parked);
    expect(
      new Set(mocks.external.mock.calls.map(([arg]) => arg.approvalDigest))
        .size,
    ).toBe(3);
  });
  it("refuses a parked proof that expires during its claim", async () => {
    rule("require_approval");
    mocks.external.mockResolvedValue({
      approvalId: "approval-1",
      expiresAt: new Date(Date.now() - 1),
      status: "approved",
    });
    await expect(
      externalDecisionCheck({
        name,
        input: {},
        ctx,
        approvalMode: "park",
        onApprovalRequired: vi.fn(),
      })(),
    ).rejects.toMatchObject({ code: "decision_rule_approval_required" });
  });
  it("rechecks current denial after claiming parked proof", async () => {
    rule("require_approval");
    mocks.external.mockImplementation(async () => {
      rule("deny");
      return {
        approvalId: "approval-1",
        expiresAt: new Date(Date.now() + 60_000),
        status: "approved",
      };
    });
    await expect(
      externalDecisionCheck({
        name,
        input: {},
        ctx,
        approvalMode: "park",
        onApprovalRequired: vi.fn(),
      })(),
    ).rejects.toMatchObject({ code: "decision_rule_denied" });
  });
  it("leaves infrastructure failure auditing to the invocation boundary", async () => {
    const emit = vi.fn();
    setSecurityEventEmitter(emit);
    clearDecisionRulesGate();
    await expect(check()()).rejects.toMatchObject({
      code: "external_rules_unavailable",
    });
    expect(emit).not.toHaveBeenCalled();
    setDecisionRulesGate(
      createDecisionRulesGate({
        loadRuleSet: async () => {
          throw new Error("offline");
        },
      }),
    );
    await expect(check()()).rejects.toThrow("offline");
    expect(emit).not.toHaveBeenCalled();
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
  it("does not emit invocation outcomes for repeated rule preflights", async () => {
    const emit = vi.fn();
    setSecurityEventEmitter(emit);
    const admit = check();
    await admit();
    await admit();
    rule("deny");
    await expect(check()()).rejects.toMatchObject({
      code: "decision_rule_denied",
    });
    expect(emit).not.toHaveBeenCalled();
  });
  it("does not retain an expired approval across a later consent wait", async () => {
    vi.useFakeTimers();
    rule("require_approval");
    const admit = check();
    await admit();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    mocks.wait.mockResolvedValue({ resolution: "denied" });
    // A second request was made, so the proof did not carry over; the
    // person then refused it, which is a denial.
    await expect(admit()).rejects.toMatchObject({
      code: "decision_rule_denied",
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
