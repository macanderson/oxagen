import { describe, expect, it } from "vitest";
import { listMembers } from "./workspace.member.list";
import { getCapability } from "../registry";
import { capabilityMutates } from "../types";

const member = {
  id: "usr_alice",
  name: "Alice",
  email: "alice@example.com",
  avatarUrl: "https://avatars.example.com/alice.png",
  role: "admin",
  joinedAt: "2024-01-15T08:00:00.000Z",
};

const invitation = {
  id: "invi_bob",
  email: "bob@example.com",
  role: "Member",
  invitedAt: "2024-02-01T00:00:00.000Z",
  expiresAt: "2024-02-08T00:00:00.000Z",
};

describe("list_members contract", () => {
  it("is registered under its Appendix E name and the former name is gone", () => {
    expect(getCapability("list_members")).toBe(listMembers);
    expect(getCapability("list_workspace_members")).toBeUndefined();
  });

  it("is a console read: mutates:false, noBillingGate:true, scoped", () => {
    expect(capabilityMutates(listMembers)).toBe(false);
    expect(listMembers.noBillingGate).toBe(true);
    expect(listMembers.scoped).toBe(true);
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("defaults the scope to the request's workspace, so callers that pass nothing keep their listing", () => {
    expect(listMembers.input.parse({}).scope).toBe("workspace");
  });

  it("accepts the org scope", () => {
    expect(listMembers.input.parse({ scope: "org" }).scope).toBe("org");
  });

  it("refuses a scope outside org | workspace", () => {
    expect(() => listMembers.input.parse({ scope: "user" })).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  it("org scope carries members and invitations", () => {
    const parsed = listMembers.output.parse({
      scope: "org",
      members: [member],
      invitations: [invitation],
    });
    expect(parsed.scope).toBe("org");
    if (parsed.scope !== "org") throw new Error("unreachable");
    expect(parsed.members[0]?.id).toBe("usr_alice");
    expect(parsed.invitations[0]?.id).toBe("invi_bob");
  });

  it("org scope requires the invitations array", () => {
    expect(() =>
      listMembers.output.parse({ scope: "org", members: [member] }),
    ).toThrow();
  });

  it("workspace scope carries members only", () => {
    const parsed = listMembers.output.parse({
      scope: "workspace",
      members: [member],
    });
    expect(parsed.scope).toBe("workspace");
    expect("invitations" in parsed).toBe(false);
  });

  it("workspace scope drops an invitations array: a workspace has none", () => {
    const parsed = listMembers.output.parse({
      scope: "workspace",
      members: [],
      invitations: [invitation],
    });
    expect("invitations" in parsed).toBe(false);
  });

  it("a member's name is nullable and its email, role and joinedAt are not", () => {
    expect(
      listMembers.output.safeParse({
        scope: "workspace",
        members: [{ ...member, name: null }],
      }).success,
    ).toBe(true);
    for (const key of ["email", "role", "joinedAt"] as const) {
      const { [key]: _dropped, ...rest } = member;
      expect(
        listMembers.output.safeParse({ scope: "workspace", members: [rest] })
          .success,
      ).toBe(false);
    }
  });

  it("a member's avatar is nullable, never blank, and always present", () => {
    const parse = (m: object) =>
      listMembers.output.safeParse({ scope: "workspace", members: [m] })
        .success;
    expect(parse({ ...member, avatarUrl: null })).toBe(true);
    expect(parse({ ...member, avatarUrl: "" })).toBe(false);
    const { avatarUrl: _dropped, ...rest } = member;
    expect(parse(rest)).toBe(false);
  });

  it("an invitation's expiresAt is nullable and its email, role and invitedAt are not", () => {
    expect(
      listMembers.output.safeParse({
        scope: "org",
        members: [],
        invitations: [{ ...invitation, expiresAt: null }],
      }).success,
    ).toBe(true);
    for (const key of ["email", "role", "invitedAt"] as const) {
      const { [key]: _dropped, ...rest } = invitation;
      expect(
        listMembers.output.safeParse({
          scope: "org",
          members: [],
          invitations: [rest],
        }).success,
      ).toBe(false);
    }
  });

  it("refuses the former bare-array output", () => {
    expect(listMembers.output.safeParse([member]).success).toBe(false);
  });
});
