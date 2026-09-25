// The Organization mappers over real list_members, list_iam_roles,
// list_workspaces and list_api_keys output: each sample is parsed by the
// contract's own output schema first, so a sample the contract would reject
// cannot make a mapper test pass. The view model parse is the boundary the
// adapter runs, so the stored role casing, the public ids, and the absence of
// anything exchangeable for access are proven here.
import { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import {
  type OrgDataPlaneGetOutput,
  orgDataPlaneGet,
} from "@oxagen/oxagen/contracts/org.data_plane.get";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { describe, expect, it } from "vitest";
import {
  ApiKeyList,
  DataPlane,
  MemberList,
  RoleCatalog,
  WorkspaceList,
} from "@/data/contracts/org";
import {
  toApiKeys,
  toDataPlane,
  toMemberList,
  toRoleCatalog,
  toWorkspaceList,
} from "./org";

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

const customRole = {
  id: "rol_7k2m9q4x8r1t5v3w6y0z2a",
  name: "agent.release",
  description: "Cuts releases and opens their pull requests.",
  scopeKind: "workspace",
  kind: "agent",
  isSystemDefault: false,
  version: "1",
  memberCount: 2,
  grants: [
    { capability: "list_runs", effect: "allow" },
    { capability: "get_run", effect: "allow" },
  ],
  permissions: ["run.read"],
  createdAt: "2026-09-15T00:00:00.000Z",
  createdBy: "Priya Natarajan",
};

const builtInRole = {
  ...customRole,
  id: "rol_9z8y7x6w5v4t3s2r1q0p9n",
  name: "Owner",
  description: null,
  scopeKind: "org",
  kind: "human",
  isSystemDefault: true,
  memberCount: 3,
  createdBy: null,
};

function catalogOut(sample: unknown) {
  return iamRoleList.output.parse(sample);
}

const rolesSample = {
  roles: [customRole, builtInRole],
  total: 2,
  hasMore: false,
  limit: 100,
  offset: 0,
  catalog: [
    {
      id: "run.read",
      group: "Runs",
      description: "Read runs, their approvals and the commands sent to them",
      capabilities: ["list_runs", "get_run", "list_approvals"],
    },
  ],
  enforcement: { tier: "enterprise", enforced: true },
};

describe("toRoleCatalog", () => {
  it("carries every role with the permissions its grants cover, who holds it and who made it", () => {
    const view = RoleCatalog.parse(toRoleCatalog(catalogOut(rolesSample)));
    expect(view.roles).toEqual([
      {
        id: "rol_7k2m9q4x8r1t5v3w6y0z2a",
        name: "agent.release",
        description: "Cuts releases and opens their pull requests.",
        scope: "workspace",
        kind: "agent",
        builtIn: false,
        permissions: ["run.read"],
        heldBy: 2,
        createdBy: "Priya Natarajan",
        createdAt: "2026-09-15T00:00:00.000Z",
      },
      {
        id: "rol_9z8y7x6w5v4t3s2r1q0p9n",
        name: "Owner",
        description: null,
        scope: "org",
        kind: "human",
        builtIn: true,
        permissions: ["run.read"],
        heldBy: 3,
        createdBy: null,
        createdAt: "2026-09-15T00:00:00.000Z",
      },
    ]);
  });

  it("carries the catalogue as the vocabulary the editor speaks, keyed by permission and not by id", () => {
    const view = RoleCatalog.parse(toRoleCatalog(catalogOut(rolesSample)));
    expect(view.catalog).toEqual([
      {
        permission: "run.read",
        group: "Runs",
        description: "Read runs, their approvals and the commands sent to them",
        capabilities: ["list_runs", "get_run", "list_approvals"],
      },
    ]);
  });

  it("reports whether the resolver runs for this organization, as recorded", () => {
    expect(
      RoleCatalog.parse(toRoleCatalog(catalogOut(rolesSample))).enforcement,
    ).toEqual({ tier: "enterprise", enforced: true });
    expect(
      RoleCatalog.parse(
        toRoleCatalog(
          catalogOut({
            ...rolesSample,
            enforcement: { tier: "free", enforced: false },
          }),
        ),
      ).enforcement,
    ).toEqual({ tier: "free", enforced: false });
  });

  it("a role id that is not a public id is refused by the view model (negative)", () => {
    const out = catalogOut({
      ...rolesSample,
      roles: [{ ...customRole, id: "7a000000-0000-4000-8000-0000000000a1" }],
    });
    expect(RoleCatalog.safeParse(toRoleCatalog(out)).success).toBe(false);
  });
});

const workspacesSample = {
  organization: {
    id: "7a000000-0000-4000-8000-0000000000a1",
    publicId: "org_1",
    slug: "acme",
    namespace: "acme",
    name: "Acme Robotics",
    avatarUrl: null,
  },
  workspaces: [
    {
      id: "7b000000-0000-4000-8000-000000000001",
      publicId: "wrk_0a1b2c3d4e5f6g7h8j9k0m",
      slug: "core-platform",
      namespace: "core",
      name: "Core platform",
      avatarUrl: null,
      role: "Owner",
      archivedAt: null,
      costCenter: null,
    },
    {
      id: "7b000000-0000-4000-8000-000000000002",
      publicId: "wrk_9z8y7x6w5v4t3s2r1q0p9n",
      slug: "research",
      namespace: "research",
      name: "Research",
      avatarUrl: null,
      role: null,
      archivedAt: "2026-09-01T08:00:00.000Z",
      costCenter: null,
    },
  ],
};

describe("toWorkspaceList", () => {
  it("carries the organization and each workspace by public id, with the viewer's role and its archival date", () => {
    const view = WorkspaceList.parse(
      toWorkspaceList(workspaceList.output.parse(workspacesSample)),
    );
    expect(view.orgId).toBe("org_1");
    expect(view.orgAvatarUrl).toBeNull();
    expect(view.workspaces).toEqual([
      {
        id: "wrk_0a1b2c3d4e5f6g7h8j9k0m",
        slug: "core-platform",
        namespace: "core",
        name: "Core platform",
        avatarUrl: null,
        role: "Owner",
        archivedAt: null,
        costCenter: null,
      },
      {
        id: "wrk_9z8y7x6w5v4t3s2r1q0p9n",
        slug: "research",
        namespace: "research",
        name: "Research",
        avatarUrl: null,
        role: null,
        archivedAt: "2026-09-01T08:00:00.000Z",
        costCenter: null,
      },
    ]);
  });

  it("carries the stored avatars of the organization and of each workspace, a link and a designed avatar alike", () => {
    const link = "https://cdn.example.test/acme.png";
    const designed = 'avatar:v1:{"kind":"initials","text":"C","font":"sans","tone":"gold"}';
    const [core, research] = workspacesSample.workspaces;
    const view = WorkspaceList.parse(
      toWorkspaceList(
        workspaceList.output.parse({
          organization: { ...workspacesSample.organization, avatarUrl: link },
          workspaces: [
            { ...core, avatarUrl: designed },
            { ...research, avatarUrl: null },
          ],
        }),
      ),
    );
    expect(view.orgAvatarUrl).toBe(link);
    expect(view.workspaces.map((w) => w.avatarUrl)).toEqual([designed, null]);
  });

  it("reads an empty avatar string as none, for the organization and a workspace (negative)", () => {
    const [core] = workspacesSample.workspaces;
    const view = WorkspaceList.parse(
      toWorkspaceList(
        workspaceList.output.parse({
          organization: { ...workspacesSample.organization, avatarUrl: "" },
          workspaces: [{ ...core, avatarUrl: "" }],
        }),
      ),
    );
    expect(view.orgAvatarUrl).toBeNull();
    expect(view.workspaces[0]?.avatarUrl).toBeNull();
  });

  it("carries the database uuid nowhere: the row's id and the organization's are public ids (negative)", () => {
    const view = WorkspaceList.parse(
      toWorkspaceList(workspaceList.output.parse(workspacesSample)),
    );
    const json = JSON.stringify(view);
    expect(json).not.toContain("7b000000-0000-4000-8000-000000000001");
    expect(json).not.toContain("7a000000-0000-4000-8000-0000000000a1");
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
  rotatable: true,
};
const revokedKey = {
  publicId: "aky_9z8y7x6w5v4t3s2r1q0p9n",
  name: "Laptop",
  prefix: "ox_oldoldoldo",
  createdAt: "2026-09-01T09:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2026-12-31T00:00:00.000Z",
  revokedAt: "2026-09-10T08:00:00.000Z",
  rotatable: true,
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
        rotatable: true,
      },
      {
        id: "aky_9z8y7x6w5v4t3s2r1q0p9n",
        name: "Laptop",
        prefix: "ox_oldoldoldo",
        createdAt: "2026-09-01T09:00:00.000Z",
        lastUsedAt: null,
        expiresAt: "2026-12-31T00:00:00.000Z",
        revokedAt: "2026-09-10T08:00:00.000Z",
        rotatable: true,
      },
    ]);
  });

  it("carries whether the key may be rotated, so the page offers no control the handler refuses", () => {
    // A key an enrollment or a login flow owns: rotate_api_key refuses it.
    const [owned] = ApiKeyList.parse(
      toApiKeys(keys({ items: [{ ...storedKey, rotatable: false }] })),
    );
    expect(owned?.rotatable).toBe(false);
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
      ...storedKey,
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
      "rotatable",
    ]);
    expect(JSON.stringify(view)).not.toContain("sha256-of-the-live-key");
    expect(JSON.stringify(view)).not.toContain("ox_thewholekey");
  });

  it("a key whose public id is a raw database id is refused by the view model (negative)", () => {
    const out = keys({
      items: [
        { ...storedKey, publicId: "7a000000-0000-4000-8000-0000000000a1" },
      ],
    });
    expect(ApiKeyList.safeParse(toApiKeys(out)).success).toBe(false);
  });
});

describe("toDataPlane", () => {
  const dedicated: OrgDataPlaneGetOutput = {
    kind: "postgres",
    mode: "dedicated",
    status: "degraded",
    host: "db.acme.internal",
    database: "oxagen_acme",
    schemaVersion: "20260920000000",
    lastVerifiedAt: "2026-09-20T08:00:00.000Z",
    rotatedAt: null,
  };

  it("carries the redacted binding the Data plane tab prints", () => {
    const view = DataPlane.parse(
      toDataPlane(orgDataPlaneGet.output.parse(dedicated)),
    );
    expect(view).toEqual({
      mode: "dedicated",
      status: "degraded",
      host: "db.acme.internal",
      database: "oxagen_acme",
      schemaVersion: "20260920000000",
      lastVerifiedAt: "2026-09-20T08:00:00.000Z",
      rotatedAt: null,
    });
  });

  it("copies no field it does not name, so a credential beside the binding does not reach the page (negative)", () => {
    // The contract strips unknown keys when it parses; the mapper is the second
    // fence, so hand it the unparsed answer a future contract could produce.
    const leaky = {
      ...dedicated,
      password: "hunter2-the-customer-db-password",
      dsn: "postgres://acme:hunter2@db.acme.internal/oxagen_acme",
    };
    const view = DataPlane.parse(toDataPlane(leaky));
    expect(Object.keys(view)).toEqual([
      "mode",
      "status",
      "host",
      "database",
      "schemaVersion",
      "lastVerifiedAt",
      "rotatedAt",
    ]);
    expect(JSON.stringify(view)).not.toContain("hunter2");
  });

  it("refuses a timestamp the binding recorded as free text (negative)", () => {
    const out = orgDataPlaneGet.output.parse({
      ...dedicated,
      lastVerifiedAt: "last Tuesday",
    });
    expect(DataPlane.safeParse(toDataPlane(out)).success).toBe(false);
  });
});
