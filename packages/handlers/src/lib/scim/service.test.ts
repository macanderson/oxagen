/**
 * The SCIM protocol end to end over an in-memory store (#3734).
 *
 * The request bodies below are the shapes Okta and Microsoft Entra ID send,
 * taken from their provisioning documentation: Okta deactivates with a
 * value-object `replace` of `{ active: false }` and renames a group the same
 * way; Entra ID capitalizes `op` ("Replace", "Add", "Remove"), sends booleans
 * as the strings "True" and "False", addresses the work email by a filter
 * path, and adds and removes group members with a `members` path. The store
 * records what the Postgres port would write, so each test reads as "this
 * payload did that to the organization".
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SsoGroupRole, SsoMappableRole } from "@oxagen/oxagen/contracts/org.sso.shared";
import { ScimError } from "./protocol";
import {
  serveScim,
  type ScimGroupRow,
  type ScimRequest,
  type ScimStore,
  type ScimUserRow,
} from "./service";

const BASE = "https://app.oxagen.sh/api/scim/v2";
const PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const ENTRA_GROUP_OBJECT_ID = "5f1b6c2e-8a44-4d4b-9d3e-0c7f2a1e9b10";

interface MemUser extends ScimUserRow {
  deleted: boolean;
}

class MemoryStore implements ScimStore {
  domains = ["acme.com"];
  mappings: SsoGroupRole[] = [
    { group: "Oxagen Admins", role: "admin" },
    { group: "Engineering", role: "member" },
    { group: ENTRA_GROUP_OBJECT_ID, role: "compliance" },
  ];
  users = new Map<string, MemUser>();
  /** Oxagen accounts with no principal in this organization. */
  accounts = new Map<string, string>();
  roles = new Map<string, string>();
  owners = new Set<string>();
  groups = new Map<string, ScimGroupRow & { members: Set<string> }>();
  deprovisioned: { userId: string; trigger: string }[] = [];
  roleWrites: { userId: string; role: SsoMappableRole | null }[] = [];
  audits: { eventType: string; detail: Record<string, unknown> }[] = [];
  private seq = 0;
  private id() {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  async verifiedDomains() {
    return this.domains;
  }
  async groupRoleMappings() {
    return this.mappings;
  }
  private live(u: MemUser | undefined) {
    return u && !u.deleted ? u : null;
  }
  async findUser(userId: string) {
    return this.live(this.users.get(userId));
  }
  async findUserByEmail(email: string) {
    return this.live([...this.users.values()].find((u) => u.email === email));
  }
  async listUsers(filter: { attribute: string; value: string } | null, offset: number, limit: number) {
    const all = [...this.users.values()].filter(
      (u) =>
        !u.deleted &&
        (filter === null ||
          (filter.attribute === "externalid"
            ? u.externalId === filter.value
            : filter.attribute === "id"
              ? u.id === filter.value
              : u.email === filter.value.toLowerCase())),
    );
    return { rows: all.slice(offset, offset + limit), total: all.length };
  }
  async provisionUser(args: {
    email: string;
    name: { displayName: string | null; givenName: string | null; familyName: string | null };
    externalId: string | null;
  }) {
    const existingAccount = this.accounts.get(args.email);
    const previous = [...this.users.values()].find((u) => u.email === args.email);
    const userId = existingAccount ?? previous?.id ?? this.id();
    this.accounts.delete(args.email);
    this.users.set(userId, {
      id: userId,
      email: args.email,
      ...args.name,
      externalId: args.externalId,
      active: true,
      deleted: false,
      createdAt: new Date("2026-09-23T10:00:00Z"),
      updatedAt: new Date("2026-09-23T10:00:00Z"),
    });
    return { userId, linked: existingAccount !== undefined || previous !== undefined };
  }
  async setUserEmail(userId: string, email: string) {
    if ([...this.users.values()].some((u) => u.email === email && u.id !== userId)) {
      throw new ScimError(409, "taken", "uniqueness");
    }
    this.users.get(userId)!.email = email;
  }
  async setUserName(userId: string, name: { displayName: string | null; givenName: string | null; familyName: string | null }) {
    Object.assign(this.users.get(userId)!, name);
  }
  async setExternalId(userId: string, externalId: string | null) {
    this.users.get(userId)!.externalId = externalId;
  }
  async isOwner(userId: string) {
    return this.owners.has(userId);
  }
  async deprovision(userId: string, trigger: "scim_active_false" | "scim_delete") {
    if (this.owners.has(userId)) throw new Error("the service must refuse an Owner first");
    this.deprovisioned.push({ userId, trigger });
    this.roles.delete(userId);
    const user = this.users.get(userId)!;
    user.active = false;
    if (trigger === "scim_delete") {
      user.deleted = true;
      for (const g of this.groups.values()) g.members.delete(userId);
    }
  }
  async reactivate(userId: string) {
    this.users.get(userId)!.active = true;
  }
  async currentRole(userId: string) {
    return this.owners.has(userId) ? "owner" : (this.roles.get(userId) ?? null);
  }
  async applyRole(userId: string, role: SsoMappableRole | null) {
    this.roleWrites.push({ userId, role });
    if (role === null) this.roles.delete(userId);
    else this.roles.set(userId, role);
  }
  async groupNamesOf(userId: string) {
    return [...this.groups.values()]
      .filter((g) => g.members.has(userId))
      .flatMap((g) => (g.externalId ? [g.displayName, g.externalId] : [g.displayName]));
  }
  async knownUsers(userIds: readonly string[]) {
    return new Set(userIds.filter((id) => this.live(this.users.get(id))));
  }
  async findGroup(groupId: string) {
    return this.groups.get(groupId) ?? null;
  }
  async findGroupByName(displayName: string) {
    return [...this.groups.values()].find((g) => g.displayName === displayName) ?? null;
  }
  async listGroups(filter: { attribute: string; value: string } | null, offset: number, limit: number) {
    const all = [...this.groups.values()].filter(
      (g) =>
        filter === null ||
        (filter.attribute === "displayname" ? g.displayName : g.externalId) === filter.value,
    );
    return { rows: all.slice(offset, offset + limit), total: all.length };
  }
  async createGroup(args: { displayName: string; externalId: string | null }) {
    const row = {
      id: this.id(),
      ...args,
      createdAt: new Date("2026-09-23T10:00:00Z"),
      updatedAt: new Date("2026-09-23T10:00:00Z"),
      members: new Set<string>(),
    };
    this.groups.set(row.id, row);
    return row;
  }
  async updateGroup(groupId: string, args: { displayName?: string; externalId?: string | null }) {
    Object.assign(this.groups.get(groupId)!, args);
  }
  async deleteGroup(groupId: string) {
    this.groups.delete(groupId);
  }
  async groupMembers(groupId: string) {
    return [...(this.groups.get(groupId)?.members ?? [])].map((userId) => ({
      userId,
      display: this.users.get(userId)?.email ?? null,
    }));
  }
  async addGroupMembers(groupId: string, userIds: readonly string[]) {
    for (const id of userIds) this.groups.get(groupId)!.members.add(id);
  }
  async removeGroupMembers(groupId: string, userIds: readonly string[]) {
    for (const id of userIds) this.groups.get(groupId)!.members.delete(id);
  }
  async audit(eventType: string, detail: Record<string, unknown>) {
    this.audits.push({ eventType, detail });
  }
}

let store: MemoryStore;
const call = (req: Partial<ScimRequest> & Pick<ScimRequest, "method" | "path">) =>
  serveScim(store, { query: {}, ...req }, BASE);
const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ScimError);
  return err as ScimError;
};

beforeEach(() => {
  store = new MemoryStore();
});

// ── Okta ─────────────────────────────────────────────────────────────────────

const oktaUser = {
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  userName: "ada@acme.com",
  name: { givenName: "Ada", familyName: "Lovelace" },
  emails: [{ primary: true, value: "ada@acme.com", type: "work" }],
  displayName: "Ada Lovelace",
  locale: "en-US",
  externalId: "00u1abcdEFGH2345",
  groups: [],
  password: "never-stored",
  active: true,
};

async function oktaProvision(): Promise<string> {
  const res = await call({ method: "POST", path: "/Users", body: oktaUser });
  return (res.body as { id: string }).id;
}

describe("Okta", () => {
  it("looks a user up by userName before creating one, and finds nobody", async () => {
    const res = await call({
      method: "GET",
      path: "/Users",
      query: { filter: 'userName eq "ada@acme.com"', startIndex: "1", count: "100" },
    });
    expect(res).toEqual({
      status: 200,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        totalResults: 0,
        startIndex: 1,
        itemsPerPage: 0,
        Resources: [],
      },
    });
  });

  it("creates a person who exists before their first sign-in, with no role", async () => {
    const res = await call({ method: "POST", path: "/Users", body: oktaUser });
    const user = res.body as Record<string, unknown>;
    expect(res.status).toBe(201);
    expect(res.location).toBe(`${BASE}/Users/${user.id}`);
    expect(user).toMatchObject({
      userName: "ada@acme.com",
      externalId: "00u1abcdEFGH2345",
      name: { givenName: "Ada", familyName: "Lovelace", formatted: "Ada Lovelace" },
      displayName: "Ada Lovelace",
      active: true,
      emails: [{ value: "ada@acme.com", primary: true, type: "work" }],
    });
    expect(JSON.stringify(user)).not.toContain("never-stored");
    // Provisioning creates the person and grants nothing; a group does that.
    expect(store.roles.size).toBe(0);
    expect(store.audits).toEqual([
      {
        eventType: "scim.user_provisioned",
        detail: {
          userId: user.id,
          userName: "ada@acme.com",
          externalId: "00u1abcdEFGH2345",
          linked: false,
        },
      },
    ]);
    // The lookup Okta runs next now finds the person.
    const found = await call({
      method: "GET",
      path: "/Users",
      query: { filter: 'userName eq "ada@acme.com"' },
    });
    expect((found.body as { totalResults: number }).totalResults).toBe(1);
  });

  it("deactivates with a value-object replace, which deprovisions the person", async () => {
    const id = await oktaProvision();
    store.roles.set(id, "admin");
    const res = await call({
      method: "PATCH",
      path: `/Users/${id}`,
      body: {
        schemas: [PATCH_OP],
        Operations: [{ op: "replace", value: { active: false } }],
      },
    });
    expect(res.status).toBe(200);
    expect((res.body as { active: boolean }).active).toBe(false);
    expect(store.deprovisioned).toEqual([{ userId: id, trigger: "scim_active_false" }]);
    expect(store.roles.has(id)).toBe(false);
  });

  it("updates the profile with a full PUT", async () => {
    const id = await oktaProvision();
    const res = await call({
      method: "PUT",
      path: `/Users/${id}`,
      body: {
        ...oktaUser,
        id,
        name: { givenName: "Augusta Ada", familyName: "King" },
        displayName: "Ada King",
      },
    });
    expect(res.body).toMatchObject({
      displayName: "Ada King",
      name: { givenName: "Augusta Ada", familyName: "King" },
      active: true,
    });
    expect(store.deprovisioned).toEqual([]);
    expect(store.audits.at(-1)).toEqual({
      eventType: "scim.user_updated",
      detail: expect.objectContaining({ userId: id, changedFields: ["name"] }),
    });
  });

  it("pushes a group, adds a member, and the mapping grants the role", async () => {
    const id = await oktaProvision();
    const created = await call({
      method: "POST",
      path: "/Groups",
      body: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "Oxagen Admins",
        members: [],
      },
    });
    expect(created.status).toBe(201);
    const groupId = (created.body as { id: string }).id;
    await call({
      method: "PATCH",
      path: `/Groups/${groupId}`,
      body: {
        schemas: [PATCH_OP],
        Operations: [
          { op: "add", path: "members", value: [{ value: id, display: "ada@acme.com" }] },
        ],
      },
    });
    expect(store.roles.get(id)).toBe("admin");
    expect(store.audits.at(-1)).toEqual({
      eventType: "scim.group_changed",
      detail: {
        groupId,
        displayName: "Oxagen Admins",
        change: "updated",
        membersAdded: [id],
        membersRemoved: [],
        rolesRecomputed: [{ userId: id, role: "admin" }],
      },
    });
  });

  it("renames a group with a value-object replace and recomputes every member", async () => {
    const id = await oktaProvision();
    const groupId = (
      (await call({
        method: "POST",
        path: "/Groups",
        body: { displayName: "Oxagen Admins", members: [{ value: id }] },
      })).body as { id: string }
    ).id;
    expect(store.roles.get(id)).toBe("admin");
    await call({
      method: "PATCH",
      path: `/Groups/${groupId}`,
      body: {
        schemas: [PATCH_OP],
        Operations: [{ op: "replace", value: { id: groupId, displayName: "Engineering" } }],
      },
    });
    expect(store.roles.get(id)).toBe("member");
  });

  it("removes a member by filter path; no mapped group left means no membership", async () => {
    const id = await oktaProvision();
    const groupId = (
      (await call({
        method: "POST",
        path: "/Groups",
        body: { displayName: "Engineering", members: [{ value: id }] },
      })).body as { id: string }
    ).id;
    await call({
      method: "PATCH",
      path: `/Groups/${groupId}`,
      body: {
        schemas: [PATCH_OP],
        Operations: [{ op: "remove", path: `members[value eq "${id}"]` }],
      },
    });
    expect(store.roleWrites.at(-1)).toEqual({ userId: id, role: null });
    expect(store.roles.has(id)).toBe(false);
    // A group removal is not a deprovision: sessions and the account stay.
    expect(store.deprovisioned).toEqual([]);
  });
});

// ── Microsoft Entra ID ───────────────────────────────────────────────────────

const entraUser = {
  schemas: [
    "urn:ietf:params:scim:schemas:core:2.0:User",
    "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User",
  ],
  externalId: "grace",
  userName: "grace@eng.acme.com",
  active: true,
  displayName: "Grace Hopper",
  emails: [{ primary: true, type: "work", value: "grace@eng.acme.com" }],
  meta: { resourceType: "User" },
  name: { formatted: "Grace Hopper", familyName: "Hopper", givenName: "Grace" },
  roles: [],
  "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {
    department: "Navy",
  },
};

async function entraProvision(): Promise<string> {
  const res = await call({ method: "POST", path: "/Users", body: entraUser });
  return (res.body as { id: string }).id;
}

describe("Microsoft Entra ID", () => {
  it("provisions a user on a subdomain of the verified domain", async () => {
    const res = await call({ method: "POST", path: "/Users", body: entraUser });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userName: "grace@eng.acme.com", externalId: "grace" });
  });

  it("finds a user by externalId", async () => {
    const id = await entraProvision();
    const res = await call({
      method: "GET",
      path: "/Users",
      query: { filter: 'externalId eq "grace"' },
    });
    expect(res.body).toMatchObject({ totalResults: 1, Resources: [{ id }] });
  });

  it('deprovisions on a capitalized "Replace" of active with the string "False"', async () => {
    const id = await entraProvision();
    const res = await call({
      method: "PATCH",
      path: `/Users/${id}`,
      body: {
        schemas: [PATCH_OP],
        Operations: [{ op: "Replace", path: "active", value: "False" }],
      },
    });
    expect((res.body as { active: boolean }).active).toBe(false);
    expect(store.deprovisioned).toEqual([{ userId: id, trigger: "scim_active_false" }]);
  });

  it("applies a mixed attribute patch and ignores what Oxagen does not store", async () => {
    const id = await entraProvision();
    const res = await call({
      method: "PATCH",
      path: `/Users/${id}`,
      body: {
        schemas: [PATCH_OP],
        Operations: [
          { op: "Add", path: "externalId", value: "grace.hopper" },
          { op: "Replace", path: "displayName", value: "Rear Admiral Hopper" },
          { op: "Replace", path: 'emails[type eq "work"].value', value: "grace@eng.acme.com" },
          { op: "Replace", path: "name.givenName", value: "Grace Brewster" },
          {
            op: "Replace",
            path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
            value: "Fleet",
          },
        ],
      },
    });
    expect(res.body).toMatchObject({
      externalId: "grace.hopper",
      displayName: "Rear Admiral Hopper",
      name: { givenName: "Grace Brewster", familyName: "Hopper" },
      active: true,
    });
    expect(store.audits.at(-1)?.detail).toMatchObject({
      changedFields: ["name", "externalId"],
    });
  });

  it("adds a member with a members path; a mapped group object id grants the role", async () => {
    const id = await entraProvision();
    const group = await call({
      method: "POST",
      path: "/Groups",
      body: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        externalId: ENTRA_GROUP_OBJECT_ID,
        displayName: "Compliance Reviewers",
        members: [],
      },
    });
    const groupId = (group.body as { id: string }).id;
    await call({
      method: "PATCH",
      path: `/Groups/${groupId}`,
      body: {
        schemas: [PATCH_OP],
        Operations: [{ op: "Add", path: "members", value: [{ value: id }] }],
      },
    });
    expect(store.roles.get(id)).toBe("compliance");

    await call({
      method: "PATCH",
      path: `/Groups/${groupId}`,
      body: {
        schemas: [PATCH_OP],
        Operations: [{ op: "Remove", path: "members", value: [{ value: id }] }],
      },
    });
    expect(store.roles.has(id)).toBe(false);
  });

  it('reactivates on "True" and recomputes the role from the groups the person is still in', async () => {
    const id = await entraProvision();
    await call({
      method: "POST",
      path: "/Groups",
      body: { displayName: "Engineering", members: [{ value: id }] },
    });
    await call({
      method: "PATCH",
      path: `/Users/${id}`,
      body: { schemas: [PATCH_OP], Operations: [{ op: "Replace", path: "active", value: "False" }] },
    });
    expect(store.roles.has(id)).toBe(false);
    await call({
      method: "PATCH",
      path: `/Users/${id}`,
      body: { schemas: [PATCH_OP], Operations: [{ op: "Replace", path: "active", value: "True" }] },
    });
    expect(store.users.get(id)?.active).toBe(true);
    expect(store.roles.get(id)).toBe("member");
  });

  it("looks groups up by displayName without members", async () => {
    await call({ method: "POST", path: "/Groups", body: { displayName: "Engineering" } });
    const res = await call({
      method: "GET",
      path: "/Groups",
      query: { filter: 'displayName eq "Engineering"', excludedAttributes: "members" },
    });
    expect(res.body).toMatchObject({ totalResults: 1 });
    expect((res.body as { Resources: object[] }).Resources[0]).not.toHaveProperty("members");
  });
});

// ── Rules ────────────────────────────────────────────────────────────────────

describe("rules every identity provider meets", () => {
  it("refuses to deprovision an Owner, by active: false or by DELETE", async () => {
    const id = await oktaProvision();
    store.owners.add(id);
    const patch = await refusal(
      call({
        method: "PATCH",
        path: `/Users/${id}`,
        body: { schemas: [PATCH_OP], Operations: [{ op: "replace", value: { active: false } }] },
      }),
    );
    expect(patch).toMatchObject({ status: 403, denial: "owner_protected" });
    expect(patch.detail).toMatch(/Owner/);
    const del = await refusal(call({ method: "DELETE", path: `/Users/${id}` }));
    expect(del).toMatchObject({ status: 403, denial: "owner_protected" });
    expect(store.deprovisioned).toEqual([]);
  });

  it("never changes an Owner's role through a group", async () => {
    const id = await oktaProvision();
    store.owners.add(id);
    const groupId = (
      (await call({
        method: "POST",
        path: "/Groups",
        body: { displayName: "Engineering", members: [{ value: id }] },
      })).body as { id: string }
    ).id;
    await call({ method: "DELETE", path: `/Groups/${groupId}` });
    expect(store.roleWrites).toEqual([]);
    expect(store.audits.at(-1)?.detail).toMatchObject({
      change: "deleted",
      rolesRecomputed: [{ userId: id, role: "owner" }],
    });
  });

  it("refuses a userName outside the organization's verified domains", async () => {
    const err = await refusal(
      call({ method: "POST", path: "/Users", body: { ...oktaUser, userName: "eve@evil.test" } }),
    );
    expect(err).toMatchObject({
      status: 400,
      scimType: "invalidValue",
      denial: "domain_not_verified",
    });
    expect(store.users.size).toBe(0);
  });

  it("does not treat a lookalike domain as a subdomain", async () => {
    const err = await refusal(
      call({ method: "POST", path: "/Users", body: { ...oktaUser, userName: "eve@notacme.com" } }),
    );
    expect(err.denial).toBe("domain_not_verified");
  });

  it("links an existing Oxagen account instead of creating a second one", async () => {
    store.accounts.set("ada@acme.com", "00000000-0000-4000-8000-00000000aaaa");
    const res = await call({ method: "POST", path: "/Users", body: oktaUser });
    expect((res.body as { id: string }).id).toBe("00000000-0000-4000-8000-00000000aaaa");
    expect(store.audits[0]?.detail).toMatchObject({ linked: true });
  });

  it("answers 409 to a second POST for the same userName", async () => {
    await oktaProvision();
    const err = await refusal(call({ method: "POST", path: "/Users", body: oktaUser }));
    expect(err).toMatchObject({ status: 409, scimType: "uniqueness" });
  });

  it("DELETE deprovisions, drops group memberships, and the user reads as gone", async () => {
    const id = await oktaProvision();
    await call({ method: "POST", path: "/Groups", body: { displayName: "Engineering", members: [{ value: id }] } });
    const res = await call({ method: "DELETE", path: `/Users/${id}` });
    expect(res).toEqual({ status: 204, body: null });
    expect(store.deprovisioned).toEqual([{ userId: id, trigger: "scim_delete" }]);
    const err = await refusal(call({ method: "GET", path: `/Users/${id}` }));
    expect(err.status).toBe(404);
  });

  it("does not store a member the organization has not provisioned", async () => {
    const res = await call({
      method: "POST",
      path: "/Groups",
      body: {
        displayName: "Engineering",
        members: [{ value: "00000000-0000-4000-8000-0000000fffff" }, { value: "not-a-uuid" }],
      },
    });
    expect((res.body as { members: unknown[] }).members).toEqual([]);
  });

  it("answers 409 to a group name already taken", async () => {
    await call({ method: "POST", path: "/Groups", body: { displayName: "Engineering" } });
    const err = await refusal(
      call({ method: "POST", path: "/Groups", body: { displayName: "Engineering" } }),
    );
    expect(err).toMatchObject({ status: 409, scimType: "uniqueness" });
  });

  it("refuses a filter it does not support", async () => {
    const err = await refusal(
      call({ method: "GET", path: "/Users", query: { filter: 'userName sw "ada"' } }),
    );
    expect(err).toMatchObject({ status: 400, scimType: "invalidFilter" });
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await refusal(call({ method: "GET", path: "/Users/nope" }))).status).toBe(404);
    expect(
      (await refusal(call({ method: "GET", path: "/Groups/00000000-0000-4000-8000-000000000999" })))
        .status,
    ).toBe(404);
  });

  it("serves the discovery documents", async () => {
    const spc = await call({ method: "GET", path: "/ServiceProviderConfig" });
    expect(spc.body).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
      authenticationSchemes: [expect.objectContaining({ type: "oauthbearertoken" })],
    });
    const types = await call({ method: "GET", path: "/ResourceTypes" });
    expect(types.body).toMatchObject({ totalResults: 2 });
    const schemas = await call({ method: "GET", path: "/Schemas" });
    expect(schemas.body).toMatchObject({ totalResults: 2 });
    const user = await call({
      method: "GET",
      path: "/Schemas/urn:ietf:params:scim:schemas:core:2.0:User",
    });
    expect(user.body).toMatchObject({ name: "User" });
  });

  it("refuses a write to a discovery document", async () => {
    const err = await refusal(call({ method: "POST", path: "/ServiceProviderConfig", body: {} }));
    expect(err.status).toBe(405);
  });
});
