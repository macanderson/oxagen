import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { agentCredentialRotate } from "./agent.credential.rotate";

describe("rotate_agent_credential contract", () => {
  it("is a credential write: mutates, unmetered, Owner/Admin, api only", () => {
    expect(getCapability("rotate_agent_credential")).toBe(
      agentCredentialRotate,
    );
    expect(agentCredentialRotate.mutates).toBe(true);
    expect(agentCredentialRotate.noBillingGate).toBe(true);
    expect(agentCredentialRotate.surfaces).toEqual(["api"]);
    expect(agentCredentialRotate.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("takes an id or slug with a bounded validity, default 180", () => {
    expect(agentCredentialRotate.input.parse({ agentId: "agt_x" })).toEqual({
      agentId: "agt_x",
      validityDays: 180,
    });
    expect(
      agentCredentialRotate.input.safeParse({
        agentId: "agt_x",
        validityDays: 366,
      }).success,
    ).toBe(false);
    expect(agentCredentialRotate.input.safeParse({}).success).toBe(false);
  });

  it("answers with the retired credential (or null when none) and the new secret once", () => {
    const credential = {
      id: "aky_0123456789abcdefghjkmn",
      secret: "ox_new",
      expiresAt: "2027-03-12T10:00:00.000Z",
    };
    expect(
      agentCredentialRotate.output.parse({
        agentId: "agt_0123456789abcdefghjkmn",
        revokedCredentialId: null,
        credential,
      }).revokedCredentialId,
    ).toBeNull();
    expect(
      agentCredentialRotate.output.parse({
        agentId: "agt_0123456789abcdefghjkmn",
        revokedCredentialId: "aky_0123456789abcdefghjkm0",
        credential,
      }).revokedCredentialId,
    ).toBe("aky_0123456789abcdefghjkm0");
    expect(
      agentCredentialRotate.output.safeParse({
        agentId: "agt_0123456789abcdefghjkmn",
        revokedCredentialId: null,
        credential: { ...credential, secret: "" },
      }).success,
    ).toBe(false);
  });
});
