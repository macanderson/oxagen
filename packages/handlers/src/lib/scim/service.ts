// What each SCIM request does (#3734), over a storage port so the whole
// protocol runs in unit tests against recorded Okta and Entra ID payloads.
// `pg-store.ts` is the Postgres port; every call of one request shares one
// transaction, so a refusal part-way through writes nothing.
//
// The rules, in the order a reader needs them:
//   - A user is a person with a human principal in this organization. POST
//     creates the Oxagen account when none exists for the userName, or links
//     the one that does; either way the person exists before their first
//     sign-in. The userName must be an email on one of the organization's
//     verified SSO domains, the same rule SSO sign-in applies.
//   - Creating or updating a user never grants or removes a role. Roles come
//     from groups: a group change recomputes the organization role of each
//     person it touches through org.sso_group_roles, highest mapped role wins,
//     deny by default, and an Owner is never changed.
//   - `active: false` and DELETE deprovision: every key and host revoked,
//     every role assignment and membership removed, in the request's
//     transaction, and every session ended when the organization owns the
//     identity (its email is on a verified domain). An Owner is refused.
//   - The Oxagen account is shared by every organization its person belongs
//     to. SCIM changes its email or its name only for an identity this
//     organization owns, and never an Owner's email. `active: true` on a
//     deprovisioned person reactivates them and recomputes their role.
import {
  resolveSsoGrantedRole,
  type SsoGroupRole,
  type SsoMappableRole,
} from "@oxagen/oxagen/contracts/org.sso.shared";
import {
  isScimId,
  listResponse,
  memberFilterValue,
  memberIds,
  pageOf,
  parseEqFilter,
  readPatch,
  resourceTypes,
  schemas,
  SCIM_GROUP_SCHEMA,
  SCIM_USER_SCHEMA,
  scimBoolean,
  ScimError,
  type ScimEqFilter,
  serviceProviderConfig,
} from "./protocol";

export interface ScimUserRow {
  id: string;
  email: string;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  externalId: string | null;
  /** False once the identity provider deprovisioned the person. */
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimGroupRow {
  id: string;
  displayName: string;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimNameInput {
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
}

export type ScimRemovalTrigger = "scim_active_false" | "scim_delete";

/** Everything one request reads and writes, all in one transaction. */
export interface ScimStore {
  /** The organization's verified SSO domains, lowercase. */
  verifiedDomains(): Promise<string[]>;
  /** Every group → role row of every one of the organization's providers. */
  groupRoleMappings(): Promise<SsoGroupRole[]>;

  findUser(userId: string): Promise<ScimUserRow | null>;
  findUserByEmail(email: string): Promise<ScimUserRow | null>;
  listUsers(
    filter: ScimEqFilter | null,
    offset: number,
    limit: number,
  ): Promise<{ rows: ScimUserRow[]; total: number }>;
  /**
   * Create the Oxagen account for `email`, or find the one that exists, and
   * give it an active principal in this organization marked as SCIM's.
   * Answers the user id and whether an existing account was linked.
   */
  provisionUser(args: {
    email: string;
    name: ScimNameInput;
    externalId: string | null;
  }): Promise<{ userId: string; linked: boolean }>;
  /** Change the account's email. Throws a 409 ScimError when another account holds it. */
  setUserEmail(userId: string, email: string): Promise<void>;
  /**
   * Record the person's name on their principal in this organization, and on
   * the shared Oxagen account too when `account` is true. The account is
   * shared by every organization the person belongs to, so only an
   * organization that owns the identity may rename it.
   */
  setUserName(
    userId: string,
    name: ScimNameInput,
    opts: { account: boolean },
  ): Promise<void>;
  setExternalId(userId: string, externalId: string | null): Promise<void>;
  isOwner(userId: string): Promise<boolean>;
  /** The shared removal transaction; also drops the person's group memberships on DELETE. */
  deprovision(
    userId: string,
    trigger: ScimRemovalTrigger,
    opts: { endSessions: boolean },
  ): Promise<void>;
  /** Clear the deprovision marker so the person's groups decide their role again. */
  reactivate(userId: string): Promise<void>;
  /** The person's organization role, lowercase, or null when not a member. */
  currentRole(userId: string): Promise<string | null>;
  /** applyMappedOrgRoleInTx for a group change. */
  applyRole(userId: string, role: SsoMappableRole | null): Promise<void>;
  /** The display names and external ids of every group the person is in. */
  groupNamesOf(userId: string): Promise<string[]>;
  /** The subset of `userIds` that are users of this organization. */
  knownUsers(userIds: readonly string[]): Promise<Set<string>>;

  findGroup(groupId: string): Promise<ScimGroupRow | null>;
  findGroupByName(displayName: string): Promise<ScimGroupRow | null>;
  listGroups(
    filter: ScimEqFilter | null,
    offset: number,
    limit: number,
  ): Promise<{ rows: ScimGroupRow[]; total: number }>;
  createGroup(args: {
    displayName: string;
    externalId: string | null;
  }): Promise<ScimGroupRow>;
  updateGroup(
    groupId: string,
    args: { displayName?: string; externalId?: string | null },
  ): Promise<void>;
  deleteGroup(groupId: string): Promise<void>;
  groupMembers(
    groupId: string,
  ): Promise<{ userId: string; display: string | null }[]>;
  addGroupMembers(groupId: string, userIds: readonly string[]): Promise<void>;
  removeGroupMembers(
    groupId: string,
    userIds: readonly string[],
  ): Promise<void>;

  /** Write a scim.* audit row in the request's transaction. */
  audit(
    eventType:
      | "scim.user_provisioned"
      | "scim.user_updated"
      | "scim.group_changed",
    detail: Record<string, unknown>,
  ): Promise<void>;
}

export interface ScimRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export interface ScimResponse {
  status: number;
  body: unknown;
  location?: string;
}

// ── Users ────────────────────────────────────────────────────────────────────

function renderUser(row: ScimUserRow, baseUrl: string) {
  const formatted =
    [row.givenName, row.familyName].filter(Boolean).join(" ") || null;
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    ...(row.externalId !== null ? { externalId: row.externalId } : {}),
    userName: row.email,
    name: {
      ...(row.givenName !== null ? { givenName: row.givenName } : {}),
      ...(row.familyName !== null ? { familyName: row.familyName } : {}),
      ...(formatted !== null ? { formatted } : {}),
    },
    ...(row.displayName !== null ? { displayName: row.displayName } : {}),
    emails: [{ value: row.email, type: "work", primary: true }],
    active: row.active,
    meta: {
      resourceType: "User",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: `${baseUrl}/Users/${row.id}`,
    },
  };
}

function str(value: unknown, attribute: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ScimError(400, `${attribute} must be a string`, "invalidValue");
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The email a user resource names: its userName, else its primary email. */
function emailOf(resource: Record<string, unknown>): string | null {
  const userName = str(resource.userName, "userName");
  if (userName !== null) return userName.toLowerCase();
  const emails: unknown[] = Array.isArray(resource.emails)
    ? (resource.emails as unknown[])
    : [];
  const primary: unknown =
    emails.find(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        (e as { primary?: unknown }).primary,
    ) ?? emails[0];
  const value =
    typeof primary === "object" && primary !== null
      ? str((primary as { value?: unknown }).value, "emails.value")
      : null;
  return value?.toLowerCase() ?? null;
}

function nameOf(resource: Record<string, unknown>): ScimNameInput {
  const name =
    typeof resource.name === "object" && resource.name !== null
      ? (resource.name as Record<string, unknown>)
      : {};
  const givenName = str(name.givenName, "name.givenName");
  const familyName = str(name.familyName, "name.familyName");
  const formatted = str(name.formatted, "name.formatted");
  const displayName =
    str(resource.displayName, "displayName") ??
    formatted ??
    ([givenName, familyName].filter(Boolean).join(" ") || null);
  return { displayName, givenName, familyName };
}

function emailDomainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

function onVerifiedDomain(email: string, verified: readonly string[]): boolean {
  const domain = emailDomainOf(email);
  return (
    domain !== null &&
    verified.some((d) => domain === d || domain.endsWith(`.${d}`))
  );
}

/**
 * Whether this organization owns the person's identity: their current email is
 * on one of its verified domains. Only then may SCIM change the shared Oxagen
 * account (its email and name) or end the person's sessions, which reach
 * every organization they belong to. A member invited from another domain,
 * such as a contractor on a personal address, is this organization's to
 * remove but not its to rename or sign out everywhere.
 */
async function ownsIdentity(store: ScimStore, email: string): Promise<boolean> {
  return onVerifiedDomain(email, await store.verifiedDomains());
}

/** The email is on one of the organization's verified domains, or a subdomain of one. */
async function assertOrgDomain(store: ScimStore, email: string): Promise<void> {
  const domain = emailDomainOf(email);
  if (domain === null) {
    throw new ScimError(
      400,
      "userName must be an email address",
      "invalidValue",
    );
  }
  const verified = await store.verifiedDomains();
  if (onVerifiedDomain(email, verified)) return;
  throw new ScimError(
    400,
    `${domain} is not a verified SSO domain of this organization. Verify it on Organization › Single sign-on first.`,
    "invalidValue",
    "domain_not_verified",
  );
}

async function requireUser(
  store: ScimStore,
  userId: string,
): Promise<ScimUserRow> {
  const row = isScimId(userId) ? await store.findUser(userId) : null;
  if (!row) throw new ScimError(404, `User ${userId} not found`);
  return row;
}

async function refuseOwner(store: ScimStore, userId: string): Promise<void> {
  if (await store.isOwner(userId)) {
    throw new ScimError(
      403,
      "This person is an Owner in Oxagen. An Owner leaves only by an ownership transfer inside Oxagen.",
      "mutability",
      "owner_protected",
    );
  }
}

/** Recompute one person's role from their groups; answers the role they hold after. */
async function recomputeRole(
  store: ScimStore,
  userId: string,
  mappings: readonly SsoGroupRole[],
): Promise<string | null> {
  // Owner by either record (org_users or the IAM assignment); a group never
  // changes an Owner.
  if (await store.isOwner(userId)) return "owner";
  const current = await store.currentRole(userId);
  const user = await store.findUser(userId);
  if (!user || !user.active) return current;
  const granted = resolveSsoGrantedRole(
    await store.groupNamesOf(userId),
    mappings,
  );
  if (granted === current || (granted === null && current === null)) {
    return current;
  }
  await store.applyRole(userId, granted);
  return granted;
}

interface UserChanges {
  email?: string;
  name?: ScimNameInput;
  externalId?: string | null;
  active?: boolean;
}

/** Apply changes to one user in a safe order: refusals first, then writes. */
async function applyUserChanges(
  store: ScimStore,
  user: ScimUserRow,
  changes: UserChanges,
): Promise<void> {
  const emailChange =
    changes.email !== undefined && changes.email !== user.email;
  if ((changes.active === false && user.active) || emailChange) {
    // An Owner is neither deprovisioned nor moved to another address by the
    // identity provider: either would hand the organization's last word to
    // whoever holds the SCIM token.
    await refuseOwner(store, user.id);
  }
  const owned = await ownsIdentity(store, user.email);
  if (emailChange) {
    // The account is shared by every organization the person belongs to.
    // Moving an address this organization does not own onto one it does
    // would let the token holder take the account over (a reset mail or an
    // SSO sign-in to the new address), so only an owned identity moves.
    if (!owned) {
      throw new ScimError(
        403,
        `${user.email} is not on a verified domain of this organization, so SCIM cannot change it.`,
        "mutability",
        "identity_not_owned",
      );
    }
    await assertOrgDomain(store, changes.email as string);
  }

  const changed: string[] = [];
  if (emailChange && changes.email !== undefined) {
    await store.setUserEmail(user.id, changes.email);
    changed.push("userName");
  }
  if (
    changes.name !== undefined &&
    (changes.name.displayName !== user.displayName ||
      changes.name.givenName !== user.givenName ||
      changes.name.familyName !== user.familyName)
  ) {
    await store.setUserName(user.id, changes.name, {
      account: owned && !(await store.isOwner(user.id)),
    });
    changed.push("name");
  }
  if (
    changes.externalId !== undefined &&
    changes.externalId !== user.externalId
  ) {
    await store.setExternalId(user.id, changes.externalId);
    changed.push("externalId");
  }
  if (changes.active === true && !user.active) {
    await store.reactivate(user.id);
    await recomputeRole(store, user.id, await store.groupRoleMappings());
    changed.push("active");
  }
  if (changed.length > 0) {
    await store.audit("scim.user_updated", {
      userId: user.id,
      userName: changes.email ?? user.email,
      externalId:
        changes.externalId !== undefined ? changes.externalId : user.externalId,
      changedFields: changed,
    });
  }
  if (changes.active === false && user.active) {
    await store.deprovision(user.id, "scim_active_false", {
      endSessions: owned,
    });
  }
}

/** Read a PATCH on a user into changes. Attributes Oxagen does not keep are ignored. */
function userPatchChanges(user: ScimUserRow, body: unknown): UserChanges {
  const changes: UserChanges = {};
  const name: ScimNameInput = {
    displayName: user.displayName,
    givenName: user.givenName,
    familyName: user.familyName,
  };
  let nameTouched = false;
  const setAttr = (path: string, value: unknown, remove: boolean) => {
    const p = path.trim().toLowerCase();
    if (p === "active") {
      if (!remove) changes.active = scimBoolean(value, "active");
    } else if (p === "username") {
      if (remove)
        throw new ScimError(400, "userName cannot be removed", "mutability");
      const email = str(value, "userName");
      if (email) changes.email = email.toLowerCase();
    } else if (p === "externalid") {
      changes.externalId = remove ? null : str(value, "externalId");
    } else if (p === "displayname") {
      name.displayName = remove ? null : str(value, "displayName");
      nameTouched = true;
    } else if (p === "name.givenname") {
      name.givenName = remove ? null : str(value, "name.givenName");
      nameTouched = true;
    } else if (p === "name.familyname") {
      name.familyName = remove ? null : str(value, "name.familyName");
      nameTouched = true;
    } else if (p === "name.formatted") {
      if (!remove) {
        name.displayName = name.displayName ?? str(value, "name.formatted");
        nameTouched = true;
      }
    } else if (p === "name") {
      const n = nameOf({ name: value });
      name.givenName = n.givenName;
      name.familyName = n.familyName;
      name.displayName = name.displayName ?? n.displayName;
      nameTouched = true;
    }
    // Every other attribute (enterprise extension fields, phone numbers,
    // emails[type eq "work"].value, which mirrors userName) is not stored,
    // and ignoring it is what lets Okta and Entra ID send their full profile.
  };
  for (const op of readPatch(body)) {
    const remove = op.op === "remove";
    if (op.path !== undefined) {
      setAttr(op.path, op.value, remove);
      continue;
    }
    if (typeof op.value !== "object" || op.value === null || remove) {
      throw new ScimError(
        400,
        "An operation without a path needs an object value",
        "invalidSyntax",
      );
    }
    for (const [key, value] of Object.entries(op.value)) {
      if (key === "name" && typeof value === "object" && value !== null) {
        for (const [sub, v] of Object.entries(
          value as Record<string, unknown>,
        )) {
          setAttr(`name.${sub}`, v, false);
        }
      } else {
        setAttr(key, value, false);
      }
    }
  }
  if (nameTouched) changes.name = name;
  return changes;
}

function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ScimError(
      400,
      "The request body must be a JSON object",
      "invalidSyntax",
    );
  }
  return body as Record<string, unknown>;
}

async function serveUsers(
  store: ScimStore,
  req: ScimRequest,
  id: string | null,
  baseUrl: string,
): Promise<ScimResponse> {
  if (id === null) {
    if (req.method === "GET") {
      const filter = parseEqFilter(req.query.filter, [
        "username",
        "externalid",
        "emails.value",
        "id",
      ]);
      const { startIndex, count } = pageOf(req.query);
      const { rows, total } = await store.listUsers(
        filter,
        startIndex - 1,
        count,
      );
      return {
        status: 200,
        body: listResponse(
          rows.map((r) => renderUser(r, baseUrl)),
          total,
          startIndex,
        ),
      };
    }
    if (req.method === "POST") {
      const resource = objectBody(req.body);
      const email = emailOf(resource);
      if (email === null) {
        throw new ScimError(400, "userName is required", "invalidValue");
      }
      await assertOrgDomain(store, email);
      const existing = await store.findUserByEmail(email);
      if (existing) {
        throw new ScimError(
          409,
          `A user with userName ${email} already exists (id ${existing.id})`,
          "uniqueness",
        );
      }
      const externalId = str(resource.externalId, "externalId");
      const { userId, linked } = await store.provisionUser({
        email,
        name: nameOf(resource),
        externalId,
      });
      await store.audit("scim.user_provisioned", {
        userId,
        userName: email,
        externalId,
        linked,
      });
      if (
        resource.active !== undefined &&
        scimBoolean(resource.active, "active") === false
      ) {
        await refuseOwner(store, userId);
        // The userName passed the domain check above, so the identity is
        // this organization's.
        await store.deprovision(userId, "scim_active_false", {
          endSessions: true,
        });
      }
      const row = await requireUser(store, userId);
      return {
        status: 201,
        body: renderUser(row, baseUrl),
        location: `${baseUrl}/Users/${userId}`,
      };
    }
    throw new ScimError(405, `${req.method} is not supported on /Users`);
  }

  const user = await requireUser(store, id);
  switch (req.method) {
    case "GET":
      return { status: 200, body: renderUser(user, baseUrl) };
    case "PUT": {
      const resource = objectBody(req.body);
      const email = emailOf(resource);
      await applyUserChanges(store, user, {
        ...(email !== null ? { email } : {}),
        name: nameOf(resource),
        externalId: str(resource.externalId, "externalId"),
        ...(resource.active !== undefined
          ? { active: scimBoolean(resource.active, "active") }
          : {}),
      });
      return {
        status: 200,
        body: renderUser(await requireUser(store, id), baseUrl),
      };
    }
    case "PATCH": {
      await applyUserChanges(store, user, userPatchChanges(user, req.body));
      return {
        status: 200,
        body: renderUser(await requireUser(store, id), baseUrl),
      };
    }
    case "DELETE":
      await refuseOwner(store, user.id);
      await store.deprovision(user.id, "scim_delete", {
        endSessions: await ownsIdentity(store, user.email),
      });
      return { status: 204, body: null };
    default:
      throw new ScimError(405, `${req.method} is not supported on /Users/{id}`);
  }
}

// ── Groups ───────────────────────────────────────────────────────────────────

async function renderGroup(
  store: ScimStore,
  row: ScimGroupRow,
  baseUrl: string,
  withMembers: boolean,
) {
  const members = withMembers ? await store.groupMembers(row.id) : null;
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: row.id,
    ...(row.externalId !== null ? { externalId: row.externalId } : {}),
    displayName: row.displayName,
    ...(members !== null
      ? {
          members: members.map((m) => ({
            value: m.userId,
            ...(m.display !== null ? { display: m.display } : {}),
            $ref: `${baseUrl}/Users/${m.userId}`,
          })),
        }
      : {}),
    meta: {
      resourceType: "Group",
      created: row.createdAt.toISOString(),
      lastModified: row.updatedAt.toISOString(),
      location: `${baseUrl}/Groups/${row.id}`,
    },
  };
}

function wantsMembers(query: Record<string, string>): boolean {
  const excluded = (query.excludedAttributes ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase());
  return !excluded.includes("members");
}

async function requireGroup(
  store: ScimStore,
  groupId: string,
): Promise<ScimGroupRow> {
  const row = isScimId(groupId) ? await store.findGroup(groupId) : null;
  if (!row) throw new ScimError(404, `Group ${groupId} not found`);
  return row;
}

interface GroupChange {
  displayName?: string;
  externalId?: string | null;
  add: Set<string>;
  remove: Set<string>;
  /** Replace the member list with exactly these ids. */
  replace?: Set<string>;
  removeAll?: boolean;
}

function groupPatchChange(body: unknown): GroupChange {
  const change: GroupChange = { add: new Set(), remove: new Set() };
  const setAttr = (
    op: "add" | "replace" | "remove",
    path: string,
    value: unknown,
  ) => {
    const p = path.trim().toLowerCase();
    const member = memberFilterValue(path);
    if (member !== null) {
      if (op === "remove") change.remove.add(member);
      else throw new ScimError(400, `Cannot ${op} ${path}`, "invalidPath");
      return;
    }
    if (p === "members") {
      if (op === "add") for (const m of memberIds(value)) change.add.add(m);
      else if (op === "replace") change.replace = new Set(memberIds(value));
      else if (value === undefined) change.removeAll = true;
      else for (const m of memberIds(value)) change.remove.add(m);
    } else if (p === "displayname") {
      if (op === "remove") {
        throw new ScimError(400, "displayName cannot be removed", "mutability");
      }
      const name = str(value, "displayName");
      if (name === null) {
        throw new ScimError(400, "displayName cannot be empty", "invalidValue");
      }
      change.displayName = name;
    } else if (p === "externalid") {
      change.externalId = op === "remove" ? null : str(value, "externalId");
    }
    // `id` (Okta repeats it in a value-object replace) and anything else is ignored.
  };
  for (const op of readPatch(body)) {
    if (op.path !== undefined) {
      setAttr(op.op, op.path, op.value);
      continue;
    }
    if (
      typeof op.value !== "object" ||
      op.value === null ||
      op.op === "remove"
    ) {
      throw new ScimError(
        400,
        "An operation without a path needs an object value",
        "invalidSyntax",
      );
    }
    for (const [key, value] of Object.entries(op.value)) {
      setAttr(op.op, key, value);
    }
  }
  return change;
}

/**
 * Write a group change, then recompute every touched person's role. A rename
 * touches every member, because the mapping matches the group by name.
 */
async function applyGroupChange(
  store: ScimStore,
  group: ScimGroupRow,
  change: GroupChange,
  kind: "created" | "updated",
): Promise<void> {
  const before = new Set(
    (await store.groupMembers(group.id)).map((m) => m.userId),
  );

  const renamed =
    (change.displayName !== undefined &&
      change.displayName !== group.displayName) ||
    (change.externalId !== undefined && change.externalId !== group.externalId);
  if (
    change.displayName !== undefined &&
    change.displayName !== group.displayName
  ) {
    const clash = await store.findGroupByName(change.displayName);
    if (clash && clash.id !== group.id) {
      throw new ScimError(
        409,
        `A group named ${change.displayName} already exists`,
        "uniqueness",
      );
    }
  }
  if (renamed) {
    await store.updateGroup(group.id, {
      ...(change.displayName !== undefined
        ? { displayName: change.displayName }
        : {}),
      ...(change.externalId !== undefined
        ? { externalId: change.externalId }
        : {}),
    });
  }

  let target = new Set(before);
  if (change.removeAll) target = new Set();
  if (change.replace) target = new Set(change.replace);
  for (const id of change.add) target.add(id);
  for (const id of change.remove) target.delete(id);
  // A member the identity provider has not provisioned here is not stored: a
  // member row can only name a person of this organization.
  const known = await store.knownUsers([...target].filter(isScimId));
  target = new Set([...target].filter((id) => known.has(id)));

  const added = [...target].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !target.has(id));
  if (added.length > 0) await store.addGroupMembers(group.id, added);
  if (removed.length > 0) await store.removeGroupMembers(group.id, removed);

  const touched = renamed
    ? new Set([...target, ...removed])
    : new Set([...added, ...removed]);
  const mappings = await store.groupRoleMappings();
  const rolesRecomputed: { userId: string; role: string | null }[] = [];
  for (const userId of touched) {
    rolesRecomputed.push({
      userId,
      role: await recomputeRole(store, userId, mappings),
    });
  }
  await store.audit("scim.group_changed", {
    groupId: group.id,
    displayName: change.displayName ?? group.displayName,
    change: kind,
    membersAdded: added,
    membersRemoved: removed,
    rolesRecomputed,
  });
}

async function serveGroups(
  store: ScimStore,
  req: ScimRequest,
  id: string | null,
  baseUrl: string,
): Promise<ScimResponse> {
  const withMembers = wantsMembers(req.query);
  if (id === null) {
    if (req.method === "GET") {
      const filter = parseEqFilter(req.query.filter, [
        "displayname",
        "externalid",
        "id",
      ]);
      const { startIndex, count } = pageOf(req.query);
      const { rows, total } = await store.listGroups(
        filter,
        startIndex - 1,
        count,
      );
      const resources = [];
      for (const row of rows) {
        resources.push(await renderGroup(store, row, baseUrl, withMembers));
      }
      return { status: 200, body: listResponse(resources, total, startIndex) };
    }
    if (req.method === "POST") {
      const resource = objectBody(req.body);
      const displayName = str(resource.displayName, "displayName");
      if (displayName === null) {
        throw new ScimError(400, "displayName is required", "invalidValue");
      }
      if (await store.findGroupByName(displayName)) {
        throw new ScimError(
          409,
          `A group named ${displayName} already exists`,
          "uniqueness",
        );
      }
      const group = await store.createGroup({
        displayName,
        externalId: str(resource.externalId, "externalId"),
      });
      await applyGroupChange(
        store,
        group,
        { add: new Set(memberIds(resource.members)), remove: new Set() },
        "created",
      );
      return {
        status: 201,
        body: await renderGroup(store, group, baseUrl, true),
        location: `${baseUrl}/Groups/${group.id}`,
      };
    }
    throw new ScimError(405, `${req.method} is not supported on /Groups`);
  }

  const group = await requireGroup(store, id);
  switch (req.method) {
    case "GET":
      return {
        status: 200,
        body: await renderGroup(store, group, baseUrl, withMembers),
      };
    case "PUT": {
      const resource = objectBody(req.body);
      const displayName = str(resource.displayName, "displayName");
      if (displayName === null) {
        throw new ScimError(400, "displayName is required", "invalidValue");
      }
      await applyGroupChange(
        store,
        group,
        {
          displayName,
          externalId: str(resource.externalId, "externalId"),
          add: new Set(),
          remove: new Set(),
          // A PUT without members leaves them as they are; one with members
          // replaces the list.
          ...(resource.members !== undefined
            ? { replace: new Set(memberIds(resource.members)) }
            : {}),
        },
        "updated",
      );
      return {
        status: 200,
        body: await renderGroup(
          store,
          await requireGroup(store, id),
          baseUrl,
          true,
        ),
      };
    }
    case "PATCH": {
      await applyGroupChange(
        store,
        group,
        groupPatchChange(req.body),
        "updated",
      );
      // Entra ID accepts 204; Okta reads the group back. Answer the group.
      return {
        status: 200,
        body: await renderGroup(
          store,
          await requireGroup(store, id),
          baseUrl,
          withMembers,
        ),
      };
    }
    case "DELETE": {
      const members = (await store.groupMembers(group.id)).map((m) => m.userId);
      await store.deleteGroup(group.id);
      const mappings = await store.groupRoleMappings();
      const rolesRecomputed: { userId: string; role: string | null }[] = [];
      for (const userId of members) {
        rolesRecomputed.push({
          userId,
          role: await recomputeRole(store, userId, mappings),
        });
      }
      await store.audit("scim.group_changed", {
        groupId: group.id,
        displayName: group.displayName,
        change: "deleted",
        membersAdded: [],
        membersRemoved: members,
        rolesRecomputed,
      });
      return { status: 204, body: null };
    }
    default:
      throw new ScimError(
        405,
        `${req.method} is not supported on /Groups/{id}`,
      );
  }
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/** Answer one SCIM request. Throws ScimError for every refusal. */
export async function serveScim(
  store: ScimStore,
  req: ScimRequest,
  baseUrl: string,
): Promise<ScimResponse> {
  const segments = req.path.split("?")[0]!.split("/").filter(Boolean);
  const [resource, id, ...rest] = segments;
  if (rest.length > 0 || resource === undefined) {
    throw new ScimError(404, `No SCIM resource at ${req.path}`);
  }
  const get = req.method === "GET";
  switch (resource) {
    case "ServiceProviderConfig":
      if (!get || id !== undefined) break;
      return { status: 200, body: serviceProviderConfig(baseUrl) };
    case "ResourceTypes": {
      if (!get) break;
      const types = resourceTypes(baseUrl);
      if (id === undefined) {
        return { status: 200, body: listResponse(types, types.length, 1) };
      }
      const one = types.find((t) => t.id === id);
      if (!one) throw new ScimError(404, `No resource type ${id}`);
      return { status: 200, body: one };
    }
    case "Schemas": {
      if (!get) break;
      const all = schemas(baseUrl);
      if (id === undefined) {
        return { status: 200, body: listResponse(all, all.length, 1) };
      }
      const one = all.find((s) => s.id === decodeURIComponent(id));
      if (!one) throw new ScimError(404, `No schema ${id}`);
      return { status: 200, body: one };
    }
    case "Users":
      return serveUsers(store, req, id ?? null, baseUrl);
    case "Groups":
      return serveGroups(store, req, id ?? null, baseUrl);
    default:
      throw new ScimError(404, `No SCIM resource at ${req.path}`);
  }
  throw new ScimError(405, `${req.method} is not supported on ${req.path}`);
}
