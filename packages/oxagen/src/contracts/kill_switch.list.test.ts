/**
 * Contract test for list_kill_switches (#2958).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { killSwitchList } from "./kill_switch.list";

describe("list_kill_switches is registered as declared", () => {
  it("is scoped, mutates=false and is never a governed action", () => {
    const cap = getCapability("list_kill_switches");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(false);
    expect(cap?.noBillingGate).toBe(true);
  });
});

describe("list_kill_switches", () => {
  it("defaults to every switch, on or off", () => {
    expect(killSwitchList.input.parse({})).toEqual({
      onlyOn: false,
      limit: 100,
    });
  });

  it("carries a cleared switch with who cleared it", () => {
    const parsed = killSwitchList.output.parse({
      denyGeneration: { org: 1, workspace: 1 },
      switches: [
        {
          id: "emd_1",
          target: { kind: "class", id: "moves_money" },
          scope: "org",
          on: false,
          reason: "suspected leak",
          flippedBy: "0192d4a8-7c1e-7a00-8000-000000000002",
          flippedAt: "2026-09-15T00:00:00.000Z",
          clearedAt: "2026-09-15T01:00:00.000Z",
          clearedBy: "0192d4a8-7c1e-7a00-8000-000000000003",
        },
      ],
    });
    expect(parsed.switches[0]?.on).toBe(false);
  });
});
