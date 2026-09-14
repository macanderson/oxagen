import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { agentRegister } from "./agent.register";

const input = { slug: "release-bot", name: "Release bot", harness: "stella" };

describe("register_agent contract", () => {
  it("is an identity write on api, mcp and cli: mutates, unmetered, Owner/Admin", () => {
    expect(getCapability("register_agent")).toBe(agentRegister);
    expect(agentRegister.mutates).toBe(true);
    expect(agentRegister.noBillingGate).toBe(true);
    expect(agentRegister.scoped).toBe(true);
    expect(agentRegister.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(agentRegister.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(agentRegister.agent?.requiresApproval).toBe(true);
  });

  it("defaults the credential validity to 180 days", () => {
    expect(agentRegister.input.parse(input)).toEqual({
      ...input,
      validityDays: 180,
    });
  });

  it("refuses a slug that is not lowercase hyphenated words, or longer than 18", () => {
    for (const slug of [
      "Release-Bot",
      "release_bot",
      "-release",
      "a".repeat(19),
      "",
    ]) {
      expect(
        agentRegister.input.safeParse({ ...input, slug }).success,
        slug,
      ).toBe(false);
    }
  });

  it("refuses a harness outside the four and a validity outside 1..365", () => {
    expect(
      agentRegister.input.safeParse({ ...input, harness: "langchain" }).success,
    ).toBe(false);
    expect(
      agentRegister.input.safeParse({ ...input, validityDays: 0 }).success,
    ).toBe(false);
    expect(
      agentRegister.input.safeParse({ ...input, validityDays: 366 }).success,
    ).toBe(false);
  });

  it("answers with the identity ids and the credential shown once", () => {
    const out = agentRegister.output.parse({
      agentId: "agt_0123456789abcdefghjkmn",
      slug: "release-bot",
      agentKey: null,
      principalId: "prn_0123456789abcdefghjkmn",
      credential: {
        id: "aky_0123456789abcdefghjkmn",
        secret: "ox_abcdefghijklmnopqrstuvwxyz",
        expiresAt: "2027-03-12T10:00:00.000Z",
      },
    });
    expect(out.credential.secret).toMatch(/^ox_/);
    expect(
      agentRegister.output.safeParse({ ...out, principalId: "usr_x" }).success,
    ).toBe(false);
  });
});
