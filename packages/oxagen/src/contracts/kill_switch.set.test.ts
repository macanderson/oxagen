/**
 * Contract test for set_kill_switch (#2958).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { killSwitchSet } from "./kill_switch.set";

describe("set_kill_switch is registered as declared", () => {
  it("is scoped, mutates=true and is never a governed action", () => {
    const cap = getCapability("set_kill_switch");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(true);
    expect(cap?.noBillingGate).toBe(true);
  });

  it("pauses for a human on the agent surface", () => {
    expect(killSwitchSet.surfaces).toContain("agent");
    expect(killSwitchSet.agent?.requiresApproval).toBe(true);
    expect(killSwitchSet.sensitivity).toBe("high");
    expect(killSwitchSet.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });
});

describe("set_kill_switch", () => {
  it("accepts every target level of spec §6.11", () => {
    const uuid = "0192d4a8-7c1e-7a00-8000-000000000001";
    for (const target of [
      { kind: "tool_version", id: "tlv_1" },
      { kind: "tool_server", id: "mcs_1" },
      { kind: "connection", id: "mcrd_1" },
      { kind: "agent", id: "agt_1" },
      { kind: "operator", id: uuid },
      { kind: "workspace", id: uuid },
      { kind: "org", id: uuid },
      { kind: "class", id: "moves_money" },
    ]) {
      expect(
        killSwitchSet.input.safeParse({ target, on: true, reason: "leak" })
          .success,
        target.kind,
      ).toBe(true);
    }
  });

  it("refuses a class that is not a tag, an operator that is not a user id, and a missing reason", () => {
    expect(
      killSwitchSet.input.safeParse({
        target: { kind: "class", id: "Moves Money" },
        on: true,
        reason: "x",
      }).success,
    ).toBe(false);
    expect(
      killSwitchSet.input.safeParse({
        target: { kind: "operator", id: "usr_1" },
        on: true,
        reason: "x",
      }).success,
    ).toBe(false);
    expect(
      killSwitchSet.input.safeParse({
        target: { kind: "org", id: "0192d4a8-7c1e-7a00-8000-000000000001" },
        on: false,
      }).success,
    ).toBe(false);
  });

  it("reports the deny generation after the flip", () => {
    const parsed = killSwitchSet.output.parse({
      switchId: "emd_1",
      on: true,
      changed: true,
      denyGeneration: { org: 4, workspace: 2 },
      grantsRevoked: 0,
    });
    expect(parsed.denyGeneration).toEqual({ org: 4, workspace: 2 });
  });
});
