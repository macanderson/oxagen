/**
 * The decision-rules gate at the kernel: a registered gate refuses an invoke
 * BEFORE the handler runs, an unregistered one changes nothing, and
 * platform-internal (org-less) invocations skip it — the same skip contract as
 * the billing gate.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CapabilityContext } from "./types";
import { clearRegistryForTests, registerCapability } from "./registry";
import {
  clearDecisionRulesGate,
  clearHandlersForTests,
  clearKernelIAMRuntime,
  clearSecurityEventEmitter,
  clearKernelTraceSink,
  setKernelIAMRuntime,
  setKernelTraceSink,
  setSecurityEventEmitter,
  invoke,
  registerHandler,
  setDecisionRulesGate,
  type KernelIAMCheckFn,
} from "./kernel";
import { createOxagenAssistantBinding } from "./oxagen-assistant";

const ctx: CapabilityContext = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  userId: "u",
  apiKeyId: null,
  requestId: "r",
  surface: "api",
  messageId: null,
};

const registerRefund = () =>
  registerCapability({
    name: "test.refund",
    domain: "test",
    description: "A scoped business action a rule can govern.",
    mode: "sync" as const,
    surfaces: ["api"] as const,
    layers: ["unit"] as const,
    sensitivity: "low" as const,
    defaultEffect: "allow" as const,
    defaultRoles: { org: {}, workspace: {} },
    input: z.object({ amount_usd: z.number() }),
    output: z.object({ ok: z.boolean() }),
  });

afterEach(() => {
  clearDecisionRulesGate();
  clearHandlersForTests();
  clearKernelIAMRuntime();
  clearRegistryForTests();
  clearSecurityEventEmitter();
  clearKernelTraceSink();
  vi.restoreAllMocks();
});

describe("kernel decision-rules gate", () => {
  it("requests fresh admission exactly once on the canonical gate", async () => {
    registerRefund();
    const handler = vi.fn(async () => ({ ok: true }));
    registerHandler("test.refund", async () => handler);
    const gate = vi.fn(async () => undefined);
    setDecisionRulesGate(gate);
    await invoke("test.refund", { amount_usd: 10 }, ctx, {
      requireFreshRules: true,
    });
    expect(gate).toHaveBeenCalledOnce();
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ requireFreshRules: true }),
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it("refuses requested fresh admission when the runtime gate is missing", async () => {
    registerRefund();
    const handler = vi.fn(async () => ({ ok: true }));
    registerHandler("test.refund", async () => handler);
    clearDecisionRulesGate();
    await expect(
      invoke("test.refund", { amount_usd: 10 }, ctx, {
        requireFreshRules: true,
      }),
    ).rejects.toMatchObject({ code: "decision_rules_unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("records unavailable rule authority in both events during fresh admission", async () => {
    registerRefund();
    const handler = vi.fn(async () => ({ ok: true }));
    registerHandler("test.refund", async () => handler);
    const security = vi.fn();
    const trace = vi.fn();
    setSecurityEventEmitter(security);
    setKernelTraceSink(trace);
    const failure = Object.assign(
      new Error("Current decision rules are unavailable"),
      {
        code: "decision_rules_unavailable",
      },
    );
    setDecisionRulesGate(async () => {
      throw failure;
    });
    await expect(
      invoke("test.refund", { amount_usd: 10 }, ctx, {
        requireFreshRules: true,
      }),
    ).rejects.toBe(failure);
    expect(handler).not.toHaveBeenCalled();
    expect(security).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        errorCode: "decision_rules_unavailable",
      }),
    );
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        errorCode: "decision_rules_unavailable",
      }),
    );
  });

  it("refuses BEFORE the handler runs, with the gate's own error", async () => {
    registerRefund();
    const handler = vi.fn(async () => ({ ok: true }));
    registerHandler("test.refund", async () => handler);
    setDecisionRulesGate(async ({ capability, input }) => {
      if (
        capability === "test.refund" &&
        (input as { amount_usd: number }).amount_usd > 500
      ) {
        throw new Error('refused by decision rule "deny-big"');
      }
    });

    await expect(
      invoke("test.refund", { amount_usd: 900 }, ctx),
    ).rejects.toThrow(/deny-big/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands the gate the VALIDATED input, not the raw body", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => ({ ok: true }));
    const seen: unknown[] = [];
    setDecisionRulesGate(async ({ input }) => {
      seen.push(input);
    });

    // Zod strips the unknown key; the gate must judge the same shape the
    // handler receives, or a rule and the action it governs read two inputs.
    await invoke("test.refund", { amount_usd: 10, sneaky: "extra" }, ctx);
    expect(seen).toEqual([{ amount_usd: 10 }]);
  });

  // #3153: an auto-approved receipt needs the call's run id to name the run
  // it belongs to. The kernel reads it off `ctx.agentRun.runId` (proven for a
  // real agent-run invocation in kernel.test.ts's "agent-run enforcement"
  // block, which sets up the IAM runtime this needs), so this pins the null
  // case the gate must see for ordinary human/API traffic, where there is no
  // run to attach a receipt to.
  it("hands the gate ctx.runId: null for a call that carries no agent run", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => ({ ok: true }));
    const seenRunIds: (string | null | undefined)[] = [];
    setDecisionRulesGate(async ({ ctx: gateCtx }) => {
      seenRunIds.push(gateCtx.runId);
    });

    await invoke("test.refund", { amount_usd: 10 }, ctx);

    expect(seenRunIds).toEqual([null]);
  });

  // The in-app assistant opens its run only after materializing tools, so
  // ctx.agentRun (Agent RBAC context) is unset when a tool's execute closure
  // is built — invoke()'s caller reads the live run id itself at call time
  // and hands it in as opts.runId, which must win over ctx.agentRun?.runId.
  it("prefers opts.runId over ctx.agentRun?.runId for the receipt's run", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => ({ ok: true }));
    const seenRunIds: (string | null | undefined)[] = [];
    setDecisionRulesGate(async ({ ctx: gateCtx }) => {
      seenRunIds.push(gateCtx.runId);
    });

    await invoke("test.refund", { amount_usd: 10 }, ctx, {
      runId: "arun_live",
    });

    expect(seenRunIds).toEqual(["arun_live"]);
  });

  it("preserves run correlation through a nested invoke", async () => {
    registerRefund();
    const receipts: Array<{
      runId: string | null | undefined;
      amount: number;
    }> = [];
    setDecisionRulesGate(async ({ ctx: gateCtx, input }) => {
      receipts.push({
        runId: gateCtx.runId,
        amount: (input as { amount_usd: number }).amount_usd,
      });
    });
    registerHandler("test.refund", async () => async (input, checkedCtx) => {
      if ((input as { amount_usd: number }).amount_usd === 10) {
        return invoke("test.refund", { amount_usd: 5 }, checkedCtx);
      }
      return { ok: true };
    });
    await invoke("test.refund", { amount_usd: 10 }, ctx, {
      runId: "arun_live",
    });
    expect(receipts).toEqual([
      { runId: "arun_live", amount: 10 },
      { runId: "arun_live", amount: 5 },
    ]);
  });

  it("a passing gate lets the handler run and return", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => ({ ok: true }));
    setDecisionRulesGate(async () => undefined);
    await expect(
      invoke("test.refund", { amount_usd: 10 }, ctx),
    ).resolves.toEqual({ ok: true });
  });

  it("no registered gate means no behaviour change at all", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => ({ ok: true }));
    await expect(
      invoke("test.refund", { amount_usd: 90000 }, ctx),
    ).resolves.toEqual({ ok: true });
  });

  it("skips unscoped capabilities, like the billing gate", async () => {
    // An org-less SCOPED invoke never reaches the gate chain at all (the
    // tenant scope rejects the empty id first), so the reachable skip case is
    // the unscoped capability — same as billing's `isScoped` condition.
    registerCapability({
      name: "test.unscoped",
      domain: "test",
      description: "An unscoped platform-internal capability.",
      mode: "sync" as const,
      surfaces: ["api"] as const,
      layers: ["unit"] as const,
      sensitivity: "low" as const,
      defaultEffect: "allow" as const,
      defaultRoles: { org: {}, workspace: {} },
      scoped: false,
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
    });
    registerHandler("test.unscoped", async () => async () => ({ ok: true }));
    const gate = vi.fn(async () => undefined);
    setDecisionRulesGate(gate);
    await invoke("test.unscoped", {}, { ...ctx, orgId: "", workspaceId: "" });
    expect(gate).not.toHaveBeenCalled();
  });
});

// ── The settlement seam (ADR-059 decision 4) ─────────────────────────────────
//
// A gate may return `{ settle, release }`. The kernel calls exactly one of
// them once the handler's outcome is known — settle with the validated
// output on success, release on a throw or on an output that fails the
// contract — inside the tenant scope, and a settlement that throws never
// replaces the invocation's own outcome.

describe("kernel decision-rules gate — settlement", () => {
  const settlementDouble = () => {
    const calls: string[] = [];
    const settled: unknown[] = [];
    return {
      calls,
      settled,
      settlement: {
        settle: async (output: unknown) => {
          calls.push("settle");
          settled.push(output);
        },
        release: async () => {
          calls.push("release");
        },
      },
    };
  };

  it("settles once with the validated output after a successful handler", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => ({
      ok: true,
      extra: "stripped",
    }));
    const d = settlementDouble();
    setDecisionRulesGate(async () => d.settlement);
    await expect(
      invoke("test.refund", { amount_usd: 10 }, ctx),
    ).resolves.toEqual({ ok: true });
    expect(d.calls).toEqual(["settle"]);
    expect(d.settled).toEqual([{ ok: true }]);
  });

  it("releases when the handler throws, and the throw is still the outcome", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => {
      throw new Error("provider down");
    });
    const d = settlementDouble();
    setDecisionRulesGate(async () => d.settlement);
    await expect(
      invoke("test.refund", { amount_usd: 10 }, ctx),
    ).rejects.toThrow("provider down");
    expect(d.calls).toEqual(["release"]);
  });

  it("releases when the output fails the contract", async () => {
    registerRefund();
    registerHandler(
      "test.refund",
      async () => async () => ({ ok: "yes" }) as unknown as { ok: boolean },
    );
    const d = settlementDouble();
    setDecisionRulesGate(async () => d.settlement);
    await expect(
      invoke("test.refund", { amount_usd: 10 }, ctx),
    ).rejects.toThrow(/invalid_output|output/i);
    expect(d.calls).toEqual(["release"]);
  });

  it("hands the gate the resolved principal and the request id", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => ({ ok: true }));
    const seen: unknown[] = [];
    setDecisionRulesGate(async (args) => {
      seen.push({ principal: args.principal, requestId: args.ctx.requestId });
    });
    await invoke("test.refund", { amount_usd: 10 }, ctx);
    // No IAM runtime is registered in this test, so the principal is null;
    // the field is present either way.
    expect(seen).toEqual([{ principal: null, requestId: "r" }]);
  });

  it("a settlement that throws is reported and never replaces the invocation's outcome", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => ({ ok: true }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setDecisionRulesGate(async () => ({
      settle: async () => {
        throw new Error("ledger unavailable");
      },
      release: async () => undefined,
    }));
    await expect(
      invoke("test.refund", { amount_usd: 10 }, ctx),
    ).resolves.toEqual({ ok: true });
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/decision settlement \(settle\) failed/),
      expect.any(Error),
    );
  });

  it("a gate that returns nothing settles nothing", async () => {
    registerRefund();
    registerHandler("test.refund", async () => async () => ({ ok: true }));
    setDecisionRulesGate(async () => undefined);
    await expect(
      invoke("test.refund", { amount_usd: 10 }, ctx),
    ).resolves.toEqual({ ok: true });
  });
});

// ── Stella's calls (ADR-235) ─────────────────────────────────────────────────
//
// The customer's workspace does not govern Stella, Oxagen's in-app assistant.
// Its calls carry a kernel-minted binding and skip the workspace's decision
// rules. The person's own IAM check still binds them, and a claimed binding
// is refused as a forgery.

describe("kernel decision-rules gate: Stella's calls (ADR-235)", () => {
  /** The refund, reachable from the API and from Stella's agent surface. */
  const registerSharedRefund = () =>
    registerCapability({
      name: "test.refund",
      domain: "test",
      description: "A scoped business action a rule can govern.",
      mode: "sync" as const,
      surfaces: ["api", "agent"] as const,
      layers: ["unit"] as const,
      sensitivity: "low" as const,
      defaultEffect: "allow" as const,
      defaultRoles: { org: {}, workspace: {} },
      input: z.object({ amount_usd: z.number() }),
      output: z.object({ ok: z.boolean() }),
    });

  /** A workspace rule that refuses any refund over $500. */
  const denyBigRefunds = vi.fn(
    async ({ input }: { input: unknown }): Promise<void> => {
      if ((input as { amount_usd: number }).amount_usd > 500) {
        throw Object.assign(new Error('refused by decision rule "deny-big"'), {
          code: "decision_rule_denied",
        });
      }
    },
  );

  const stellaCtx = (): CapabilityContext => ({
    ...ctx,
    surface: "app",
    messageId: "msg_turn",
    oxagenAssistant: createOxagenAssistantBinding({ requestId: ctx.requestId }),
  });

  afterEach(() => {
    denyBigRefunds.mockClear();
  });

  it("blocks a refund through the API and lets Stella make the same refund", async () => {
    registerSharedRefund();
    const handler = vi.fn(async () => ({ ok: true }));
    registerHandler("test.refund", async () => handler);
    setDecisionRulesGate(denyBigRefunds);

    await expect(
      invoke("test.refund", { amount_usd: 900 }, ctx, { surface: "api" }),
    ).rejects.toThrow(/deny-big/);
    expect(handler).not.toHaveBeenCalled();

    await expect(
      invoke("test.refund", { amount_usd: 900 }, stellaCtx(), {
        surface: "agent",
      }),
    ).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
    // The rule judged the API call and never saw Stella's.
    expect(denyBigRefunds).toHaveBeenCalledOnce();
  });

  it("keeps the person's IAM check on Stella's call", async () => {
    registerSharedRefund();
    const handler = vi.fn(async () => ({ ok: true }));
    registerHandler("test.refund", async () => handler);
    setDecisionRulesGate(denyBigRefunds);
    const check = vi.fn<KernelIAMCheckFn>(async () => ({
      outcome: "deny",
      reason: "role does not grant test.refund",
      principal: null,
    }));
    setKernelIAMRuntime(check, /* enforced */ true);

    await expect(
      invoke("test.refund", { amount_usd: 10 }, stellaCtx(), {
        surface: "agent",
      }),
    ).rejects.toMatchObject({ code: "authz_denied" });
    expect(check).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips the gate for a call nested inside Stella's call", async () => {
    registerSharedRefund();
    setDecisionRulesGate(denyBigRefunds);
    const amounts: number[] = [];
    registerHandler("test.refund", async () => async (input, checkedCtx) => {
      const amount = (input as { amount_usd: number }).amount_usd;
      amounts.push(amount);
      if (amount === 900) {
        return invoke("test.refund", { amount_usd: 800 }, checkedCtx);
      }
      return { ok: true };
    });

    await expect(
      invoke("test.refund", { amount_usd: 900 }, stellaCtx(), {
        surface: "agent",
      }),
    ).resolves.toEqual({ ok: true });
    expect(amounts).toEqual([900, 800]);
    expect(denyBigRefunds).not.toHaveBeenCalled();
  });

  it("runs the gate when the context also names a customer's agent run", async () => {
    registerSharedRefund();
    const handler = vi.fn(async () => ({ ok: true }));
    registerHandler("test.refund", async () => handler);
    setDecisionRulesGate(denyBigRefunds);
    const agentRunCtx: CapabilityContext = {
      ...stellaCtx(),
      surface: "runner",
      agentRun: {
        principalKind: "agent",
        agentPrincipal: {
          id: "00000000-0000-0000-0000-0000000000a1",
          kind: "agent",
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
        humanPrincipal: {
          id: "00000000-0000-0000-0000-0000000000a2",
          kind: "human",
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
        agentId: "agt_customer",
        runId: "run_customer",
        parentRunId: null,
      },
    };

    await expect(
      invoke("test.refund", { amount_usd: 900 }, agentRunCtx, {
        surface: "agent",
      }),
    ).rejects.toThrow(/deny-big/);
    expect(handler).not.toHaveBeenCalled();
  });

  // Mac's ruling of 2026-10-01: the open-source Stella coding agent a
  // customer runs as a CLI is a customer agent, governed like Claude Code
  // and Codex. Its calls reach the kernel through the MCP gateway carrying
  // the name wherever a caller can write one, and no binding. The name
  // exempts nothing.
  it("runs the gate for a context that names stella everywhere but holds no binding", async () => {
    registerSharedRefund();
    const handler = vi.fn(async () => ({ ok: true }));
    registerHandler("test.refund", async () => handler);
    setDecisionRulesGate(denyBigRefunds);
    const named: CapabilityContext = {
      ...ctx,
      userId: "stella",
      apiKeyId: "stella",
      requestId: "stella",
      messageId: "stella",
      toolCallId: "stella",
      surface: "mcp",
    };

    await expect(
      invoke("test.refund", { amount_usd: 900 }, named, { surface: "agent" }),
    ).rejects.toThrow(/deny-big/);
    expect(handler).not.toHaveBeenCalled();
    expect(denyBigRefunds).toHaveBeenCalledOnce();
  });

  it("resumes a parked Stella call with no rules gate registered", async () => {
    registerSharedRefund();
    const handler = vi.fn(async () => ({ ok: true }));
    registerHandler("test.refund", async () => handler);
    clearDecisionRulesGate();

    await expect(
      invoke("test.refund", { amount_usd: 900 }, stellaCtx(), {
        surface: "agent",
        requireFreshRules: true,
      }),
    ).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  const forgeries: { name: string; binding: () => unknown }[] = [
    { name: "a literal true", binding: () => true },
    {
      name: "a hand-built object",
      binding: () => ({ principalKind: "oxagen_assistant", requestId: "r" }),
    },
    {
      name: "a spread copy of a minted binding",
      binding: () => ({ ...createOxagenAssistantBinding({ requestId: "r" }) }),
    },
    {
      name: "a JSON round trip of a minted binding",
      binding: () =>
        JSON.parse(
          JSON.stringify(createOxagenAssistantBinding({ requestId: "r" })),
        ) as unknown,
    },
  ];

  it.each(forgeries)(
    "refuses $name as a forged binding and audits it",
    async ({ binding }) => {
      registerSharedRefund();
      const handler = vi.fn(async () => ({ ok: true }));
      registerHandler("test.refund", async () => handler);
      setDecisionRulesGate(denyBigRefunds);
      const security = vi.fn();
      setSecurityEventEmitter(security);
      // What an API or MCP request would have to smuggle into the context.
      const claimed = {
        ...ctx,
        oxagenAssistant: binding(),
      } as unknown as CapabilityContext;

      await expect(
        invoke("test.refund", { amount_usd: 10 }, claimed, { surface: "api" }),
      ).rejects.toMatchObject({ code: "authz_denied" });
      expect(handler).not.toHaveBeenCalled();
      expect(denyBigRefunds).not.toHaveBeenCalled();
      expect(security).toHaveBeenCalledWith(
        expect.objectContaining({
          capability: "test.refund",
          outcome: "deny",
          errorCode: "authz_denied",
        }),
      );
    },
  );
});
