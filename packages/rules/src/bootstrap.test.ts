/**
 * The loader's caching and degradation contract, and the one-shot wiring.
 *
 * Two properties are worth a test rather than a reading. The cache must serve
 * a negative result — most workspaces author no rules, and a miss that still
 * reads the settings row puts the table on the hot path of every tool call,
 * which is the whole reason the cache exists. And a stored rule set that no
 * longer parses must degrade to ungoverned-with-alarm rather than failing
 * every agent action, because `workspace.settings.write` is a generic merge
 * with no schema for this key yet.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RuleSet } from "./types";

const findFirst = vi.fn();
const setDecisionRulesGate = vi.fn();
const loggerError = vi.fn();
const loggerWarn = vi.fn();
const loggerInfo = vi.fn();

vi.mock("@oxagen/database", () => ({
  schema: { workspaces: { id: "workspaces.id" } },
  withTenantDb: (fn: (tx: unknown) => unknown) =>
    fn({ query: { workspaces: { findFirst } } }),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  setDecisionRulesGate: (gate: unknown) => setDecisionRulesGate(gate),
}));

vi.mock("./logger", () => ({
  logger: { error: loggerError, warn: loggerWarn, info: loggerInfo },
}));

const RULES: RuleSet = {
  schema: "oxagen.decision-rules.v1",
  rules: [
    {
      id: "deny-big",
      description: "big refunds are refused",
      capability: "issue_refund",
      when: { fact: "input.amount_usd", op: "gt", value: 500 },
      effect: "deny",
    },
  ],
};

const WS = { orgId: "org-1", workspaceId: "ws-1" };

/** Import fresh so `booted` and the module-level cache start clean per test. */
async function freshModule() {
  vi.resetModules();
  return import("./bootstrap");
}

beforeEach(() => {
  findFirst.mockReset();
  setDecisionRulesGate.mockReset();
  loggerError.mockReset();
  loggerWarn.mockReset();
  loggerInfo.mockReset();
});

describe("loadWorkspaceRuleSet", () => {
  test("a workspace-less call never touches the database", async () => {
    const { loadWorkspaceRuleSet } = await freshModule();

    await expect(
      loadWorkspaceRuleSet({ orgId: "org-1", workspaceId: null }),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  test("parses a stored rule set out of the settings bag", async () => {
    const { loadWorkspaceRuleSet } = await freshModule();
    findFirst.mockResolvedValue({ settings: { decisionRules: RULES } });

    await expect(loadWorkspaceRuleSet(WS)).resolves.toEqual(RULES);
  });

  test("a second read inside the TTL is served from cache", async () => {
    const { loadWorkspaceRuleSet } = await freshModule();
    findFirst.mockResolvedValue({ settings: { decisionRules: RULES } });

    await loadWorkspaceRuleSet(WS);
    await loadWorkspaceRuleSet(WS);

    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  test("the absence of rules is cached too, not re-read every call", async () => {
    const { loadWorkspaceRuleSet } = await freshModule();
    findFirst.mockResolvedValue({ settings: {} });

    await expect(loadWorkspaceRuleSet(WS)).resolves.toBeNull();
    await expect(loadWorkspaceRuleSet(WS)).resolves.toBeNull();

    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  test("a missing workspace row reads as no rules", async () => {
    const { loadWorkspaceRuleSet } = await freshModule();
    findFirst.mockResolvedValue(undefined);

    await expect(loadWorkspaceRuleSet(WS)).resolves.toBeNull();
  });

  test("a stale entry past the TTL is re-read", async () => {
    const { loadWorkspaceRuleSet } = await freshModule();
    findFirst.mockResolvedValue({ settings: { decisionRules: RULES } });

    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(now);
      await loadWorkspaceRuleSet(WS);
      clock.mockReturnValue(now + 30_001);
      await loadWorkspaceRuleSet(WS);
    } finally {
      clock.mockRestore();
    }

    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  test("malformed stored rules degrade to ungoverned and log LOUDLY", async () => {
    const { loadWorkspaceRuleSet } = await freshModule();
    findFirst.mockResolvedValue({
      settings: { decisionRules: { schema: "nope", rules: "not-an-array" } },
    });

    await expect(loadWorkspaceRuleSet(WS)).resolves.toBeNull();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(loggerError.mock.calls[0]?.[1]).toContain("UNGOVERNED");
  });

  test("clearDecisionRulesCache forces the next read to hit the database", async () => {
    const { loadWorkspaceRuleSet, clearDecisionRulesCache } =
      await freshModule();
    findFirst.mockResolvedValue({ settings: { decisionRules: RULES } });

    await loadWorkspaceRuleSet(WS);
    clearDecisionRulesCache();
    await loadWorkspaceRuleSet(WS);

    expect(findFirst).toHaveBeenCalledTimes(2);
  });
});

describe("bootstrapDecisionRulesRuntime", () => {
  test("registers the gate exactly once however often it is called", async () => {
    const { bootstrapDecisionRulesRuntime } = await freshModule();

    bootstrapDecisionRulesRuntime();
    bootstrapDecisionRulesRuntime();

    expect(setDecisionRulesGate).toHaveBeenCalledTimes(1);
    expect(setDecisionRulesGate.mock.calls[0]?.[0]).toBeTypeOf("function");
  });

  test("the gate's onError logs the infrastructure failure it fails open on", async () => {
    const { bootstrapDecisionRulesRuntime } = await freshModule();
    findFirst.mockRejectedValue(new Error("settings table missing"));
    bootstrapDecisionRulesRuntime();

    const gate = setDecisionRulesGate.mock.calls[0]?.[0] as (args: {
      capability: string;
      input: unknown;
      ctx: { orgId: string; workspaceId: string | null; userId: string | null };
    }) => Promise<void>;

    await expect(
      gate({
        capability: "issue_refund",
        input: { amount_usd: 10 },
        ctx: { orgId: "org-1", workspaceId: "ws-1", userId: null },
      }),
    ).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[1]).toContain("failing open");
  });
});
