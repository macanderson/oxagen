import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { agentRegister } from "./agent.register";

const RUNTIME_ID = "rtm_0123456789abcdefghjkmn";
const input = {
  name: "Release bot",
  harness: "stella",
  runtimeId: RUNTIME_ID,
};

describe("register_agent contract", () => {
  it("is an identity write on api and cli: mutates, unmetered, Owner/Admin", () => {
    expect(getCapability("register_agent")).toBe(agentRegister);
    expect(agentRegister.mutates).toBe(true);
    expect(agentRegister.noBillingGate).toBe(true);
    expect(agentRegister.scoped).toBe(true);
    expect(agentRegister.surfaces).toEqual(["api", "cli"]);
    expect(agentRegister.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
    expect(agentRegister.agent?.requiresApproval).toBe(true);
  });

  it("defaults the credential validity to 180 days and leaves the slug and belt to the server", () => {
    expect(agentRegister.input.parse(input)).toEqual({
      ...input,
      validityDays: 180,
    });
  });

  it("requires a runtime: an agent is one harness on one runtime (ADR-192)", () => {
    const { runtimeId: _omit, ...withoutRuntime } = input;
    expect(agentRegister.input.safeParse(withoutRuntime).success).toBe(false);
    expect(
      agentRegister.input.safeParse({ ...input, runtimeId: "macs-laptop" })
        .success,
    ).toBe(false);
  });

  it("takes a toolbelt by public id only", () => {
    expect(
      agentRegister.input.safeParse({
        ...input,
        toolbeltId: "tbt_0123456789abcdefghjkmn",
      }).success,
    ).toBe(true);
    expect(
      agentRegister.input.safeParse({ ...input, toolbeltId: "all-tools" })
        .success,
    ).toBe(false);
  });

  it("refuses a typed slug that is not lowercase hyphenated words, or longer than 18", () => {
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
    expect(
      agentRegister.input.safeParse({ ...input, slug: "release-bot" }).success,
    ).toBe(true);
  });

  it("accepts codex and cursor, the hook-based harnesses beside claude-code", () => {
    for (const harness of ["codex", "cursor"]) {
      expect(
        agentRegister.input.safeParse({ ...input, harness }).success,
        harness,
      ).toBe(true);
    }
  });

  it("refuses a harness outside the six and a validity outside 1..365", () => {
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

  it("answers with the identity ids, its runtime, belt and first version, and the credential shown once", () => {
    const out = agentRegister.output.parse({
      agentId: "agt_0123456789abcdefghjkmn",
      slug: "release-bot",
      agentKey: null,
      principalId: "prn_0123456789abcdefghjkmn",
      runtime: { id: RUNTIME_ID, name: "Mac's laptop", slug: "macs-laptop" },
      toolbelt: {
        id: "tbt_0123456789abcdefghjkmn",
        name: "All tools",
        slug: "all-tools",
        kind: "all_tools",
      },
      version: 1,
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
    expect(agentRegister.output.safeParse({ ...out, version: 0 }).success).toBe(
      false,
    );
  });
});
