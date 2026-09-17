import { describe, expect, it } from "vitest";
import { tachoEnrollmentCreate } from "./tacho.enrollment.create";
import { tachoHostEnroll } from "./tacho.host.enroll";

const FACTS = {
  token: "oxe_1time_0123456789abcdefghjkmnpqrs",
  hostname: "mbp.local",
  osUser: "dev",
  platform: "darwin",
  devicePublicKey: `ed25519:${"A".repeat(44)}`,
  harnesses: ["claude-code"],
};

describe("enroll_host contract", () => {
  it("is unscoped and allow by default: the token is the credential, and no model reaches it", () => {
    expect(tachoHostEnroll.scoped).toBe(false);
    expect(tachoHostEnroll.defaultEffect).toBe("allow");
    expect(tachoHostEnroll.surfaces).toEqual(["api", "cli"]);
    expect(tachoHostEnroll.mutates).toBe(true);
    expect(tachoHostEnroll.noBillingGate).toBe(true);
  });

  it("takes the operator enrollment's host facts plus the token and the git remote", () => {
    const parsed = tachoHostEnroll.input.parse({
      ...FACTS,
      repositoryRemote: "git@github.com:acme/widgets.git",
    });
    expect(parsed).toMatchObject({
      ...FACTS,
      managed: false,
      validityDays: 180,
      repositoryRemote: "git@github.com:acme/widgets.git",
    });
    for (const key of Object.keys(tachoEnrollmentCreate.input.shape)) {
      expect(tachoHostEnroll.input.shape, key).toHaveProperty(key);
    }
    expect(
      tachoHostEnroll.input.safeParse({ ...FACTS, token: "oxe_1time_short" })
        .success,
    ).toBe(false);
    expect(
      tachoHostEnroll.input.safeParse({ ...FACTS, org: "acme" }).success,
    ).toBe(false);
  });

  it("answers the enrollment document plus the agent and the tenant the token named", () => {
    for (const key of Object.keys(tachoEnrollmentCreate.output.shape)) {
      expect(tachoHostEnroll.output.shape, key).toHaveProperty(key);
    }
    expect(Object.keys(tachoHostEnroll.output.shape)).toEqual(
      expect.arrayContaining(["agentId", "orgSlug", "workspaceSlug"]),
    );
  });
});
