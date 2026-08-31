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
  clearSecurityEventEmitter,
  invoke,
  registerHandler,
  setDecisionRulesGate,
} from "./kernel";

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
  clearRegistryForTests();
  clearSecurityEventEmitter();
  vi.restoreAllMocks();
});

describe("kernel decision-rules gate", () => {
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
