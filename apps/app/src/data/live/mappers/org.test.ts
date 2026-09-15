// The People mapper over real list_members output: each sample is parsed by the
// contract's own output schema first, so a sample the contract would reject
// cannot make a mapper test pass. The view model parse is the boundary the
// adapter runs, so the stored role casing and the public ids are proven here.
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { describe, expect, it } from "vitest";
import { MemberList } from "@/data/contracts/org";
import { toMemberList } from "./org";

function roster(sample: unknown) {
  const out = listMembers.output.parse(sample);
  if (out.scope !== "org") throw new Error("sample is not an org roster");
  return out;
}

const marcus = {
  id: "usr_7k2m9q4x8r1t5v3w6y0z2a",
  name: "Marcus Bell",
  email: "marcus.bell@acme.example",
  role: "owner",
  joinedAt: "2026-03-02T09:15:00.000Z",
};
const unnamed = {
  id: "usr_0a1b2c3d4e5f6g7h8j9k0m",
  name: null,
  email: "ops@acme.example",
  role: "Member",
  joinedAt: "2026-05-11T16:40:00.000Z",
};
const invited = {
  id: "invi_4n5p6q7r8s9t0v1w2x3y4z",
  email: "dana.reyes@acme.example",
  role: "Admin",
  invitedAt: "2026-09-10T12:00:00.000Z",
  expiresAt: "2026-09-17T12:00:00.000Z",
};
const standing = {
  id: "invi_9z8y7x6w5v4t3s2r1q0p9n",
  email: "audit@acme.example",
  role: "compliance",
  invitedAt: "2026-09-01T08:00:00.000Z",
  expiresAt: null,
};

describe("toMemberList", () => {
  it("carries every member and pending invitation, with each stored role as the spec's lowercase enum", () => {
    const out = roster({
      scope: "org",
      members: [marcus, unnamed],
      invitations: [invited, standing],
    });
    expect(MemberList.parse(toMemberList(out))).toEqual({
      members: [
        { ...marcus, role: "owner" },
        { ...unnamed, role: "member" },
      ],
      invitations: [
        { ...invited, role: "admin" },
        { ...standing, role: "compliance" },
      ],
    });
  });

  it("keeps a missing display name and a missing expiry as null, never an invented value", () => {
    const view = MemberList.parse(
      toMemberList(
        roster({ scope: "org", members: [unnamed], invitations: [standing] }),
      ),
    );
    expect(view.members[0]?.name).toBeNull();
    expect(view.invitations[0]?.expiresAt).toBeNull();
  });

  it("maps an organization with no pending invitations to an empty list", () => {
    expect(
      MemberList.parse(
        toMemberList(
          roster({ scope: "org", members: [marcus], invitations: [] }),
        ),
      ).invitations,
    ).toEqual([]);
  });

  it("a stored role outside the spec's set is refused by the view model (negative)", () => {
    const out = roster({
      scope: "org",
      members: [{ ...marcus, role: "superuser" }],
      invitations: [],
    });
    expect(MemberList.safeParse(toMemberList(out)).success).toBe(false);
  });

  it("an id that is not a public id is refused by the view model (negative)", () => {
    const out = roster({
      scope: "org",
      members: [],
      invitations: [{ ...invited, id: "7a000000-0000-4000-8000-0000000000a1" }],
    });
    expect(MemberList.safeParse(toMemberList(out)).success).toBe(false);
  });
});
