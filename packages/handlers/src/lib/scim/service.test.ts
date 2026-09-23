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
  /** Whether each deprovision ended the person's sessions everywhere. */
  sessionsEnded: boolean[] = [];
  /** Whether each name change reached the shared Oxagen account. */
  accountRenames: boolean[] = [];
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
  async setUserName(
    userId: string,
    name: { displayName: string | null; givenName: string | null; familyName: string | null },
    opts: { account: boolean },
  ) {
    this.accountRenames.push(opts.account);
    Object.assign(this.users.get(userId)!, name);
  }
  async setExternalId(userId: string, externalId: string | null) {
    this.users.get(userId)!.externalId = externalId;
  }
  async isOwner(userId: string) {
    return this.owners.has(userId);
  }
  async deprovision(
    userId: string,
    trigger: "scim_active_false" | "scim_delete",
    opts: { endSessions: boolean },
  ) {
    this.sessionsEnded.push(opts.endSessions);
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

// ── Paths the recorded payloads do not reach ─────────────────────────────────

const patchUser = (id: string, Operations: unknown[]) =>
  call({ method: "PATCH", path: `/Users/${id}`, body: { schemas: [PATCH_OP], Operations } });
const patchGroup = (id: string, Operations: unknown[]) =>
  call({ method: "PATCH", path: `/Groups/${id}`, body: { schemas: [PATCH_OP], Operations } });
async function pushGroup(displayName: string, members: string[], externalId?: string) {
  const res = await call({
    method: "POST",
    path: "/Groups",
    body: { displayName, externalId, members: members.map((value) => ({ value })) },
  });
  return (res.body as { id: string }).id;
}

describe("changing a userName", () => {
  it("moves the account to a new address on a verified domain and records the field", async () => {
    const id = await oktaProvision();
    const res = await patchUser(id, [{ op: "replace", path: "userName", value: "Ada.King@acme.com" }]);
    expect(res.body).toMatchObject({ userName: "ada.king@acme.com" });
    expect(store.audits.at(-1)).toEqual({
      eventType: "scim.user_updated",
      detail: expect.objectContaining({
        userId: id,
        userName: "ada.king@acme.com",
        changedFields: ["userName"],
      }),
    });
  });

  it("refuses an address off the organization's verified domains and writes nothing", async () => {
    const id = await oktaProvision();
    const audits = store.audits.length;
    const err = await refusal(
      patchUser(id, [{ op: "replace", path: "userName", value: "ada@evil.test" }]),
    );
    expect(err).toMatchObject({ status: 400, denial: "domain_not_verified" });
    expect(store.users.get(id)?.email).toBe("ada@acme.com");
    expect(store.audits).toHaveLength(audits);
  });

  it("answers the store's 409 when another account holds the address", async () => {
    const ada = await oktaProvision();
    await entraProvision();
    const err = await refusal(
      patchUser(ada, [{ op: "replace", path: "userName", value: "grace@eng.acme.com" }]),
    );
    expect(err).toMatchObject({ status: 409, scimType: "uniqueness" });
  });

  it("refuses to remove the userName", async () => {
    const id = await oktaProvision();
    const err = await refusal(patchUser(id, [{ op: "remove", path: "userName" }]));
    expect(err).toMatchObject({ status: 400, scimType: "mutability" });
  });

  it("refuses a userName that is not an email address", async () => {
    for (const userName of ["ada", "ada@", "@acme.com"]) {
      const err = await refusal(call({ method: "POST", path: "/Users", body: { userName } }));
      expect(err).toMatchObject({ status: 400, scimType: "invalidValue" });
      expect(err.denial).toBeUndefined();
    }
  });
});

describe("identities the organization does not own (security review of #3734)", () => {
  /** A member invited from another domain, as SCIM finds them by filter. */
  function seedOffDomain(): string {
    const id = "00000000-0000-4000-8000-00000000c0c0";
    store.users.set(id, {
      id,
      email: "contractor@gmail.com",
      displayName: "Contractor",
      givenName: null,
      familyName: null,
      externalId: null,
      active: true,
      deleted: false,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    return id;
  }

  it("refuses to move an off-domain account onto the organization's domain", async () => {
    // The takeover: the token holder moves someone else's shared account to an
    // address whose mailbox the organization controls.
    const id = seedOffDomain();
    const err = await refusal(
      patchUser(id, [{ op: "replace", path: "userName", value: "takeover@acme.com" }]),
    );
    expect(err).toMatchObject({ status: 403, denial: "identity_not_owned" });
    expect(store.users.get(id)?.email).toBe("contractor@gmail.com");
  });

  it("refuses to change an Owner's userName, even on the organization's domain", async () => {
    const id = await oktaProvision();
    store.owners.add(id);
    const err = await refusal(
      patchUser(id, [{ op: "replace", path: "userName", value: "someone.else@acme.com" }]),
    );
    expect(err).toMatchObject({ status: 403, denial: "owner_protected" });
    expect(store.users.get(id)?.email).toBe("ada@acme.com");
  });

  it("renames the shared account only for an owned identity that is not an Owner", async () => {
    const offDomain = seedOffDomain();
    await patchUser(offDomain, [{ op: "replace", path: "displayName", value: "New Name" }]);
    const owned = await oktaProvision();
    await patchUser(owned, [{ op: "replace", path: "displayName", value: "Ada K" }]);
    const owner = await entraProvision();
    store.owners.add(owner);
    await patchUser(owner, [{ op: "replace", path: "displayName", value: "Rear Admiral" }]);
    expect(store.accountRenames).toEqual([false, true, false]);
  });

  it("deprovisions an off-domain member without ending their sessions elsewhere", async () => {
    const offDomain = seedOffDomain();
    await patchUser(offDomain, [{ op: "replace", path: "active", value: false }]);
    const owned = await oktaProvision();
    await call({ method: "DELETE", path: `/Users/${owned}` });
    expect(store.deprovisioned.map((d) => d.userId)).toEqual([offDomain, owned]);
    expect(store.sessionsEnded).toEqual([false, true]);
  });
});

describe("user PATCH edges", () => {
  it("replaces name parts by the name path and by a nested value object, keeping the display name", async () => {
    const id = await oktaProvision();
    await patchUser(id, [
      { op: "replace", path: "name", value: { givenName: "Augusta", familyName: "King", formatted: "x" } },
    ]);
    expect(store.users.get(id)).toMatchObject({
      givenName: "Augusta",
      familyName: "King",
      displayName: "Ada Lovelace",
    });
    await patchUser(id, [{ op: "replace", value: { name: { givenName: "Ada" } } }]);
    expect(store.users.get(id)).toMatchObject({ givenName: "Ada", familyName: "King" });
  });

  it("removes name parts, and takes name.formatted as the display name only when there is none", async () => {
    const id = await oktaProvision();
    await patchUser(id, [
      { op: "remove", path: "name.familyName" },
      { op: "remove", path: "displayName" },
      { op: "replace", path: "name.formatted", value: "Countess of Lovelace" },
      { op: "remove", path: "name.formatted" },
    ]);
    expect(store.users.get(id)).toMatchObject({
      familyName: null,
      displayName: "Countess of Lovelace",
    });
    await patchUser(id, [{ op: "replace", path: "name.formatted", value: "Ignored" }]);
    expect(store.users.get(id)?.displayName).toBe("Countess of Lovelace");
  });

  it("clears the external id on remove", async () => {
    const id = await oktaProvision();
    await patchUser(id, [{ op: "remove", path: "externalId" }]);
    expect(store.users.get(id)?.externalId).toBeNull();
    expect(store.audits.at(-1)?.detail).toMatchObject({ externalId: null, changedFields: ["externalId"] });
  });

  it("writes no audit row when nothing changed", async () => {
    const id = await oktaProvision();
    const audits = store.audits.length;
    await patchUser(id, [
      { op: "replace", path: "externalId", value: oktaUser.externalId },
      { op: "replace", path: "active", value: true },
      { op: "remove", path: "active" },
    ]);
    expect(store.audits).toHaveLength(audits);
    expect(store.deprovisioned).toEqual([]);
  });

  it("refuses an operation without a path whose value is not an object, and a remove without a path", async () => {
    const id = await oktaProvision();
    for (const op of [
      { op: "replace", value: "Ada" },
      { op: "add", value: null },
      { op: "remove", value: { active: false } },
    ]) {
      const err = await refusal(patchUser(id, [op]));
      expect(err).toMatchObject({ status: 400, scimType: "invalidSyntax" });
    }
    expect(store.deprovisioned).toEqual([]);
  });

  it("refuses a non-string attribute value", async () => {
    const id = await oktaProvision();
    const err = await refusal(patchUser(id, [{ op: "replace", path: "displayName", value: 7 }]));
    expect(err).toMatchObject({ status: 400, scimType: "invalidValue" });
  });

  it("refuses an active value that is not a boolean", async () => {
    const id = await oktaProvision();
    const err = await refusal(patchUser(id, [{ op: "replace", path: "active", value: "no" }]));
    expect(err).toMatchObject({ status: 400, scimType: "invalidValue" });
    expect(store.deprovisioned).toEqual([]);
  });
});

describe("user POST and PUT edges", () => {
  it("takes the primary email, else the first, when no userName is sent", async () => {
    const primary = await call({
      method: "POST",
      path: "/Users",
      body: {
        emails: [
          { value: "home@elsewhere.test" },
          { value: "Ada@Acme.com", primary: true },
        ],
      },
    });
    expect(primary.body).toMatchObject({ userName: "ada@acme.com" });
    const first = await call({
      method: "POST",
      path: "/Users",
      body: { emails: [{ value: "grace@acme.com" }, "not-an-object"] },
    });
    expect(first.body).toMatchObject({ userName: "grace@acme.com" });
  });

  it("refuses a POST with no userName and no usable email", async () => {
    for (const body of [{}, { emails: [] }, { emails: ["ada@acme.com"] }]) {
      const err = await refusal(call({ method: "POST", path: "/Users", body }));
      expect(err).toMatchObject({ status: 400, detail: "userName is required" });
    }
    expect(store.users.size).toBe(0);
  });

  it("refuses a body that is not a JSON object", async () => {
    for (const body of [[oktaUser], "ada", null]) {
      const err = await refusal(call({ method: "POST", path: "/Users", body }));
      expect(err).toMatchObject({ status: 400, scimType: "invalidSyntax" });
    }
  });

  it("provisions a person pushed as inactive straight into the deprovisioned state", async () => {
    const res = await call({ method: "POST", path: "/Users", body: { ...oktaUser, active: "False" } });
    const id = (res.body as { id: string }).id;
    expect(res).toMatchObject({ status: 201, body: { active: false } });
    expect(store.deprovisioned).toEqual([{ userId: id, trigger: "scim_active_false" }]);
  });

  it("refuses to link an Owner's account as inactive", async () => {
    const owner = "00000000-0000-4000-8000-00000000aaaa";
    store.accounts.set("ada@acme.com", owner);
    store.owners.add(owner);
    const err = await refusal(
      call({ method: "POST", path: "/Users", body: { ...oktaUser, active: false } }),
    );
    expect(err).toMatchObject({ status: 403, denial: "owner_protected" });
    expect(store.deprovisioned).toEqual([]);
  });

  it("deprovisions on a PUT with active false, and leaves active alone when PUT omits it", async () => {
    const id = await oktaProvision();
    const { active: _omit, ...withoutActive } = oktaUser;
    await call({ method: "PUT", path: `/Users/${id}`, body: withoutActive });
    expect(store.deprovisioned).toEqual([]);
    const res = await call({ method: "PUT", path: `/Users/${id}`, body: { ...oktaUser, active: false } });
    expect(res.body).toMatchObject({ active: false });
    expect(store.deprovisioned).toEqual([{ userId: id, trigger: "scim_active_false" }]);
  });

  it("reads one user by id", async () => {
    const id = await oktaProvision();
    const res = await call({ method: "GET", path: `/Users/${id}` });
    expect(res).toMatchObject({
      status: 200,
      body: { id, userName: "ada@acme.com", meta: { location: `${BASE}/Users/${id}` } },
    });
  });
});

describe("group PUT", () => {
  it("replaces the member list and recomputes the people who left and joined", async () => {
    const ada = await oktaProvision();
    const grace = await entraProvision();
    const groupId = await pushGroup("Engineering", [ada]);
    expect(store.roles.get(ada)).toBe("member");

    const res = await call({
      method: "PUT",
      path: `/Groups/${groupId}`,
      body: { displayName: "Oxagen Admins", members: [{ value: grace }] },
    });
    expect(res.status).toBe(200);
    expect((res.body as { members: { value: string }[] }).members.map((m) => m.value)).toEqual([
      grace,
    ]);
    expect(store.roles.get(grace)).toBe("admin");
    expect(store.roles.has(ada)).toBe(false);
    expect(store.audits.at(-1)?.detail).toMatchObject({
      change: "updated",
      displayName: "Oxagen Admins",
      membersAdded: [grace],
      membersRemoved: [ada],
    });
  });

  it("keeps the members when PUT omits them, and a rename still recomputes each", async () => {
    const ada = await oktaProvision();
    const groupId = await pushGroup("Engineering", [ada]);
    await call({ method: "PUT", path: `/Groups/${groupId}`, body: { displayName: "Oxagen Admins" } });
    expect(store.groups.get(groupId)?.members).toEqual(new Set([ada]));
    expect(store.roles.get(ada)).toBe("admin");
  });

  it("refuses a PUT without a displayName", async () => {
    const groupId = await pushGroup("Engineering", []);
    const err = await refusal(call({ method: "PUT", path: `/Groups/${groupId}`, body: { displayName: " " } }));
    expect(err).toMatchObject({ status: 400, scimType: "invalidValue" });
  });
});

describe("group PATCH edges", () => {
  it("refuses a rename onto another group's name and writes nothing", async () => {
    await pushGroup("Oxagen Admins", []);
    const ada = await oktaProvision();
    const groupId = await pushGroup("Engineering", [ada]);
    const roleWrites = store.roleWrites.length;
    const err = await refusal(
      patchGroup(groupId, [{ op: "replace", path: "displayName", value: "Oxagen Admins" }]),
    );
    expect(err).toMatchObject({ status: 409, scimType: "uniqueness" });
    expect(store.groups.get(groupId)?.displayName).toBe("Engineering");
    expect(store.roleWrites).toHaveLength(roleWrites);
  });

  it("refuses to remove the displayName or set it empty", async () => {
    const groupId = await pushGroup("Engineering", []);
    expect(await refusal(patchGroup(groupId, [{ op: "remove", path: "displayName" }]))).toMatchObject({
      status: 400,
      scimType: "mutability",
    });
    expect(
      await refusal(patchGroup(groupId, [{ op: "replace", path: "displayName", value: "" }])),
    ).toMatchObject({ status: 400, scimType: "invalidValue" });
  });

  it("refuses to add or replace through a member filter path", async () => {
    const ada = await oktaProvision();
    const groupId = await pushGroup("Engineering", []);
    for (const op of ["add", "replace"]) {
      const err = await refusal(
        patchGroup(groupId, [{ op, path: `members[value eq "${ada}"]`, value: { value: ada } }]),
      );
      expect(err).toMatchObject({ status: 400, scimType: "invalidPath" });
    }
    expect(store.groups.get(groupId)?.members.size).toBe(0);
  });

  it("empties the group on a members remove with no value, and recomputes everyone", async () => {
    const ada = await oktaProvision();
    const grace = await entraProvision();
    const groupId = await pushGroup("Engineering", [ada, grace]);
    await patchGroup(groupId, [{ op: "remove", path: "members" }]);
    expect(store.groups.get(groupId)?.members.size).toBe(0);
    expect(store.roles.size).toBe(0);
    expect(store.audits.at(-1)?.detail).toMatchObject({ membersRemoved: [ada, grace] });
  });

  it("replaces the members with a members replace", async () => {
    const ada = await oktaProvision();
    const grace = await entraProvision();
    const groupId = await pushGroup("Engineering", [ada]);
    await patchGroup(groupId, [{ op: "replace", path: "members", value: [{ value: grace }] }]);
    expect(store.groups.get(groupId)?.members).toEqual(new Set([grace]));
    expect(store.roles.has(ada)).toBe(false);
    expect(store.roles.get(grace)).toBe("member");
  });

  it("removing the external id a mapping matched on takes back the role it granted", async () => {
    const grace = await entraProvision();
    const groupId = await pushGroup("Compliance Reviewers", [grace], ENTRA_GROUP_OBJECT_ID);
    expect(store.roles.get(grace)).toBe("compliance");
    await patchGroup(groupId, [{ op: "remove", path: "externalId" }]);
    expect(store.groups.get(groupId)?.externalId).toBeNull();
    expect(store.roles.has(grace)).toBe(false);
  });

  it("refuses a remove without a path", async () => {
    const groupId = await pushGroup("Engineering", []);
    const err = await refusal(patchGroup(groupId, [{ op: "remove", value: { members: [] } }]));
    expect(err).toMatchObject({ status: 400, scimType: "invalidSyntax" });
  });
});

describe("role recompute", () => {
  it("never grants a role to a deprovisioned person still listed in a group", async () => {
    const ada = await oktaProvision();
    const groupId = await pushGroup("Engineering", [ada]);
    await patchUser(ada, [{ op: "replace", path: "active", value: false }]);
    expect(store.roles.has(ada)).toBe(false);
    const writes = store.roleWrites.length;
    // A rename touches every member, including the deprovisioned one.
    await patchGroup(groupId, [{ op: "replace", path: "displayName", value: "Oxagen Admins" }]);
    expect(store.roleWrites).toHaveLength(writes);
    expect(store.roles.has(ada)).toBe(false);
    expect(store.audits.at(-1)?.detail).toMatchObject({
      rolesRecomputed: [{ userId: ada, role: null }],
    });
  });

  it("writes no role when the person's role does not change", async () => {
    const ada = await oktaProvision();
    await pushGroup("Engineering", [ada]);
    const writes = store.roleWrites.length;
    store.mappings.push({ group: "Platform", role: "member" });
    await pushGroup("Platform", [ada]);
    expect(store.roleWrites).toHaveLength(writes);
    expect(store.roles.get(ada)).toBe("member");
  });

  it("reads one group with its members", async () => {
    const ada = await oktaProvision();
    const groupId = await pushGroup("Engineering", [ada]);
    const res = await call({ method: "GET", path: `/Groups/${groupId}` });
    expect(res.body).toMatchObject({
      id: groupId,
      members: [{ value: ada, display: "ada@acme.com", $ref: `${BASE}/Users/${ada}` }],
    });
  });

  it("refuses a group POST without a displayName", async () => {
    const err = await refusal(call({ method: "POST", path: "/Groups", body: { members: [] } }));
    expect(err).toMatchObject({ status: 400, scimType: "invalidValue" });
  });
});

describe("routing", () => {
  it.each([
    ["PUT", "/Users"],
    ["DELETE", "/Groups"],
    ["POST", "/Users/00000000-0000-4000-8000-000000000001"],
  ] as const)("answers 405 to %s %s", async (method, path) => {
    if (path.startsWith("/Users/")) await oktaProvision();
    const err = await refusal(call({ method, path, body: {} }));
    expect(err.status).toBe(405);
  });

  it("answers 405 to a POST on a group", async () => {
    const groupId = await pushGroup("Engineering", []);
    expect((await refusal(call({ method: "POST", path: `/Groups/${groupId}`, body: {} }))).status).toBe(
      405,
    );
  });

  it.each(["/", "/Nope", "/Users/a/b", "/ResourceTypes/Device", "/Schemas/urn:nope"])(
    "answers 404 at %s",
    async (path) => {
      expect((await refusal(call({ method: "GET", path }))).status).toBe(404);
    },
  );

  it("serves one resource type and one schema by id, ignoring a query string", async () => {
    expect((await call({ method: "GET", path: "/ResourceTypes/Group" })).body).toMatchObject({
      endpoint: "/Groups",
    });
    expect(
      (await call({
        method: "GET",
        path: "/Schemas/urn%3Aietf%3Aparams%3Ascim%3Aschemas%3Acore%3A2.0%3AGroup",
      })).body,
    ).toMatchObject({ name: "Group" });
    expect((await call({ method: "GET", path: "/ServiceProviderConfig?x=1" })).status).toBe(200);
  });

  it("refuses a write to the resource types and schemas", async () => {
    for (const path of ["/ResourceTypes", "/Schemas", "/ServiceProviderConfig/extra"]) {
      expect((await refusal(call({ method: "POST", path, body: {} }))).status).toBe(405);
    }
  });
});
