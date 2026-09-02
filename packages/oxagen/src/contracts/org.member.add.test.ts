import { describe, expect, it } from "vitest";
import { orgMemberAdd } from "./org.member.add";
import { getCapability } from "../registry";

describe("org.member.add capability", () => {
  it("parses a valid invite input", () => {
    const parsed = orgMemberAdd.input.parse({
      email: "alice@example.com",
      role: "Admin",
    });
    expect(parsed).toEqual({ email: "alice@example.com", role: "Admin" });
  });

  it("rejects an invalid email", () => {
    expect(() =>
      orgMemberAdd.input.parse({ email: "not-an-email", role: "Admin" }),
    ).toThrow();
  });

  it("rejects an empty role", () => {
    expect(() =>
      orgMemberAdd.input.parse({ email: "a@b.com", role: "" }),
    ).toThrow();
  });

  it("rejects a missing email", () => {
    expect(() => orgMemberAdd.input.parse({ role: "Admin" })).toThrow();
  });

  it("parses a valid pending-invitation output", () => {
    const parsed = orgMemberAdd.output.parse({
      invitationId: "inv_1",
      email: "alice@example.com",
      role: "Admin",
      status: "pending",
      expiresAt: null,
    });
    expect(parsed.status).toBe("pending");
    expect(parsed.expiresAt).toBeNull();
  });

  it("rejects an output whose status is not the 'pending' literal", () => {
    expect(() =>
      orgMemberAdd.output.parse({
        invitationId: "inv_1",
        email: "alice@example.com",
        role: "Admin",
        status: "accepted",
        expiresAt: null,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("add_org_member")).toBe(orgMemberAdd);
  });

  it("defaults to deny with seat-sensitive metadata", () => {
    expect(orgMemberAdd.defaultEffect).toBe("deny");
    expect(orgMemberAdd.sensitivity).toBe("high");
  });
});
