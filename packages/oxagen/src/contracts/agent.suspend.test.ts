import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { agentSuspend } from "./agent.suspend";

describe("suspend_agent contract", () => {
  it("is a governance write on the identity: mutates, unmetered, Owner/Admin", () => {
    expect(getCapability("suspend_agent")).toBe(agentSuspend);
    expect(agentSuspend.mutates).toBe(true);
    expect(agentSuspend.noBillingGate).toBe(true);
    expect(agentSuspend.surfaces).toEqual(["api"]);
    expect(agentSuspend.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("suspends by default and resumes with suspended: false", () => {
    expect(agentSuspend.input.parse({ agentId: "release-bot" })).toEqual({
      agentId: "release-bot",
      suspended: true,
    });
    expect(
      agentSuspend.input.parse({ agentId: "release-bot", suspended: false })
        .suspended,
    ).toBe(false);
    expect(
      agentSuspend.input.safeParse({ agentId: "x", reason: "r".repeat(513) })
        .success,
    ).toBe(false);
  });

  it("answers with the status the principal now holds", () => {
    const out = agentSuspend.output.parse({
      agentId: "agt_0123456789abcdefghjkmn",
      status: "suspended",
      changedAt: "2026-09-14T10:00:00.000Z",
    });
    expect(out.status).toBe("suspended");
    expect(
      agentSuspend.output.safeParse({ ...out, status: "retired" }).success,
    ).toBe(false);
  });
});
