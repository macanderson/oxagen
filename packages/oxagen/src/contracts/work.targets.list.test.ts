import { describe, expect, it } from "vitest";
import { WORK_TARGET_REFUSALS, workTargetsList as contract } from "./work.targets.list";

const AGENT = {
  id: "agt_01",
  name: "Bot",
  harness: "claude-code",
  runtime: { id: "rtm_01", name: "Laptop", tier: "harness" },
  host: { name: "laptop-1", last_poll_at: "2026-10-01T10:00:00.000Z", takes_work_orders: true },
  operates: true,
  busy_with: null,
  can_take: true,
  reason: null,
  quiet: false,
};

// list_work_targets (P1-05, #5163).
describe("list_work_targets contract", () => {
  it("registers a read on the API surface that never meters", () => {
    expect(contract.name).toBe("list_work_targets");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.scoped).toBe(true);
    expect(contract.mutates).toBe(false);
    expect(contract.noBillingGate).toBe(true);
    expect(contract.defaultRoles.workspace.Viewer).toBe("allow");
  });

  it("takes no input", () => {
    expect(contract.input.parse({})).toEqual({});
    expect(contract.input.safeParse({ agent_id: "agt_01" }).success).toBe(false);
  });

  it("answers each agent with its runtime, host, and why it cannot take a send", () => {
    expect(contract.output.parse({ agents: [AGENT] })).toEqual({ agents: [AGENT] });
    const busy = { ...AGENT, busy_with: { id: "wi_02", number: "WI-2" }, can_take: false, reason: "busy" };
    expect(contract.output.safeParse({ agents: [busy] }).success).toBe(true);
    const bare = { ...AGENT, runtime: null, host: null, can_take: false, reason: "no_runtime" };
    expect(contract.output.safeParse({ agents: [bare] }).success).toBe(true);
    expect(WORK_TARGET_REFUSALS).toEqual(["no_runtime", "no_host", "host_outdated", "not_operator", "busy"]);
  });

  it("refuses a reason, a tier, or a field the contract does not name", () => {
    expect(contract.output.safeParse({ agents: [{ ...AGENT, reason: "offline" }] }).success).toBe(false);
    expect(contract.output.safeParse({ agents: [{ ...AGENT, runtime: { ...AGENT.runtime, tier: "sandbox" } }] }).success).toBe(false);
    expect(contract.output.safeParse({ agents: [{ ...AGENT, mandate_id: "mnd_01" }] }).success).toBe(false);
  });
});
