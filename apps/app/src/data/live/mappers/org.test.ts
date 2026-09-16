// The Organization mappers over real list_members and list_api_keys output:
// each sample is parsed by the contract's own output schema first, so a sample
// the contract would reject cannot make a mapper test pass. The view model
// parse is the boundary the adapter runs, so the stored role casing, the
// public ids, and the absence of anything exchangeable for access are proven
// here.
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { describe, expect, it } from "vitest";
import { ApiKeyList, MemberList } from "@/data/contracts/org";
import { toApiKeys, toMemberList } from "./org";

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

const storedKey = {
  publicId: "aky_7k2m9q4x8r1t5v3w6y0z2a",
  name: "CI runner",
  prefix: "ox_liveliveli",
  createdAt: "2026-09-13T10:00:00.000Z",
  lastUsedAt: "2026-09-14T11:30:00.000Z",
  expiresAt: null,
  revokedAt: null,
};
const revokedKey = {
  publicId: "aky_9z8y7x6w5v4t3s2r1q0p9n",
  name: "Laptop",
  prefix: "ox_oldoldoldo",
  createdAt: "2026-09-01T09:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2026-12-31T00:00:00.000Z",
  revokedAt: "2026-09-10T08:00:00.000Z",
};

function keys(sample: unknown) {
  return apiKeyList.output.parse(sample);
}

describe("toApiKeys", () => {
  it("carries every key in the order the contract listed them, under its public id", () => {
    const view = ApiKeyList.parse(
      toApiKeys(keys({ items: [storedKey, revokedKey] })),
    );
    expect(view).toEqual([
      {
        id: "aky_7k2m9q4x8r1t5v3w6y0z2a",
        name: "CI runner",
        prefix: "ox_liveliveli",
        createdAt: "2026-09-13T10:00:00.000Z",
        lastUsedAt: "2026-09-14T11:30:00.000Z",
        expiresAt: null,
        revokedAt: null,
      },
      {
        id: "aky_9z8y7x6w5v4t3s2r1q0p9n",
        name: "Laptop",
        prefix: "ox_oldoldoldo",
        createdAt: "2026-09-01T09:00:00.000Z",
        lastUsedAt: null,
        expiresAt: "2026-12-31T00:00:00.000Z",
        revokedAt: "2026-09-10T08:00:00.000Z",
      },
    ]);
  });

  it("keeps an unused key, a key with no expiry and a live key as null, never an invented value", () => {
    const [key] = ApiKeyList.parse(toApiKeys(keys({ items: [storedKey] })));
    expect(key?.expiresAt).toBeNull();
    expect(key?.revokedAt).toBeNull();
    const [old] = ApiKeyList.parse(toApiKeys(keys({ items: [revokedKey] })));
    expect(old?.lastUsedAt).toBeNull();
  });

  it("maps an organization with no keys to an empty list", () => {
    expect(ApiKeyList.parse(toApiKeys(keys({ items: [] })))).toEqual([]);
  });

  it("copies no field it does not name, so a secret or a hash beside the metadata does not reach the view (negative)", () => {
    const leaky = {
      ...apiKeyList.output.parse({ items: [storedKey] }).items[0],
      keyHash: "sha256-of-the-live-key",
      secret: "ox_thewholekey",
    };
    const view = ApiKeyList.parse(toApiKeys({ items: [leaky] }));
    expect(Object.keys(view[0] ?? {})).toEqual([
      "id",
      "name",
      "prefix",
      "createdAt",
      "lastUsedAt",
      "expiresAt",
      "revokedAt",
    ]);
    expect(JSON.stringify(view)).not.toContain("sha256-of-the-live-key");
    expect(JSON.stringify(view)).not.toContain("ox_thewholekey");
  });

  it("a key whose public id is a raw database id is refused by the view model (negative)", () => {
    const out = keys({
      items: [{ ...storedKey, publicId: "7a000000-0000-4000-8000-0000000000a1" }],
    });
    expect(ApiKeyList.safeParse(toApiKeys(out)).success).toBe(false);
  });
});
