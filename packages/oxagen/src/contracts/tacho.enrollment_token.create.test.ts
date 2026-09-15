import { describe, expect, it } from "vitest";
import {
  ENROLLMENT_TOKEN_TTL_MINUTES_DEFAULT,
  enrollmentTokenSchema,
  tachoEnrollmentTokenCreate,
} from "./tacho.enrollment_token.create";

const TOKEN = "oxe_1time_0123456789abcdefghjkmnpqrs";

describe("create_enrollment_token contract", () => {
  it("is a credential mint: API and CLI only, never MCP or an agent, Owner/Admin, outside the meter", () => {
    expect(tachoEnrollmentTokenCreate.surfaces).toEqual(["api", "cli"]);
    expect(tachoEnrollmentTokenCreate.layers).not.toContain("mcp");
    expect(tachoEnrollmentTokenCreate.mutates).toBe(true);
    expect(tachoEnrollmentTokenCreate.noBillingGate).toBe(true);
    expect(tachoEnrollmentTokenCreate.scoped).toBe(true);
    expect(tachoEnrollmentTokenCreate.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("defaults the TTL to thirty minutes and caps it at sixty", () => {
    expect(
      tachoEnrollmentTokenCreate.input.parse({ agentId: "agt_0123456789" }),
    ).toEqual({
      agentId: "agt_0123456789",
      ttlMinutes: ENROLLMENT_TOKEN_TTL_MINUTES_DEFAULT,
    });
    expect(
      tachoEnrollmentTokenCreate.input.safeParse({
        agentId: "agt_0123456789",
        ttlMinutes: 61,
      }).success,
    ).toBe(false);
    expect(
      tachoEnrollmentTokenCreate.input.safeParse({ agentId: "release-manager" })
        .success,
    ).toBe(false);
  });

  it("the token is oxe_1time_ then 26 Crockford characters, and the output carries the enroll command", () => {
    expect(enrollmentTokenSchema.safeParse(TOKEN).success).toBe(true);
    for (const bad of [
      "oxe_1time_0123456789abcdefghjkmnpq",
      "oxe_1time_0123456789abcdefghijklmnop",
      "oxe_live_0123456789abcdefghjkmnpqrs",
      "OXE_1TIME_0123456789ABCDEFGHJKMNPQRS",
    ]) {
      expect(enrollmentTokenSchema.safeParse(bad).success, bad).toBe(false);
    }
    const out = {
      tokenId: "tet_0123456789",
      token: TOKEN,
      expiresAt: "2026-09-15T12:30:00.000Z",
      agentId: "agt_0123456789",
      agentKey: "acme.core.release-manager",
      enrollCommand: `oxagen agent enroll --token ${TOKEN}`,
    };
    expect(tachoEnrollmentTokenCreate.output.parse(out)).toEqual(out);
  });
});
