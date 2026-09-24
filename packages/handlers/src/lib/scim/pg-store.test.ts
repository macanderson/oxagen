/**
 * The Postgres port of the SCIM service (#3734), asserted on the statements it
 * sends.
 *
 * Every SCIM request runs in withSystemDb, which bypasses row-level security,
 * so the `org_id` predicate on each statement is the whole tenant boundary:
 * a statement that loses it reads or writes another organization's people.
 * The transaction here is drizzle's own pg-proxy driver, so what each test
 * reads is the SQL and the bound parameters the port would really send, not a
 * reconstruction. Reads answer rows in select-list order, the way the proxy
 * driver expects them.
 *
 * The removal transaction and the role grant are proven in
 * packages/database/src/member-lifecycle.test.ts; here they are mocked to
 * record what the port hands them. The same statements run against a real
 * Postgres in integration/scim-deprovision.test.ts (CI's rls-integration job).
 */
import { drizzle } from "drizzle-orm/pg-proxy";
import { schema, type Tx } from "@oxagen/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  isOrgOwner: vi.fn(),
  removeOrgMemberInTx: vi.fn(),
  applyMappedOrgRoleInTx: vi.fn(),
  emitSecurityEventIn: vi.fn(),
}));
vi.mock("@oxagen/database/member-lifecycle", () => ({
  isOrgOwner: lifecycle.isOrgOwner,
  removeOrgMemberInTx: lifecycle.removeOrgMemberInTx,
  applyMappedOrgRoleInTx: lifecycle.applyMappedOrgRoleInTx,
}));
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventIn: lifecycle.emitSecurityEventIn,
}));

import { createPgScimStore } from "./pg-store";
import { ScimError } from "./protocol";

const ORG = "00000000-0000-4000-8000-00000000000a";
const USER = "00000000-0000-4000-8000-0000000000aa";
const OTHER_USER = "00000000-0000-4000-8000-0000000000bb";
const GROUP = "00000000-0000-4000-8000-0000000000c1";
const REQUEST_ID = "req-1";
const T1 = new Date("2026-09-23T10:00:00Z");
const T2 = new Date("2026-09-23T11:00:00Z");

interface Stmt {
  sql: string;
  params: unknown[];
}

let stmts: Stmt[];
/** Rows the next statement matching `match` answers, consumed in order. */
let answers: { match: RegExp; rows: unknown[][] }[];

function renderingTx(): Tx {
  const db = drizzle(
    async (sql, params, method) => {
      stmts.push({ sql, params });
      if (method === "execute") return { rows: [] };
      const i = answers.findIndex((a) => a.match.test(sql));
      if (i === -1) return { rows: [] };
      const [hit] = answers.splice(i, 1);
      return { rows: hit!.rows };
    },
    { schema },
  );
  return db as unknown as Tx;
}

const store = () => createPgScimStore(renderingTx(), ORG, REQUEST_ID);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");

/** Every value bound to `<column> = $n` in the statement. */
function boundTo(stmt: Stmt, column: string): unknown[] {
  const re = new RegExp(`${escape(column)} = \\$(\\d+)`, "g");
  return [...stmt.sql.matchAll(re)].map((m) => stmt.params[Number(m[1]) - 1]);
}

const PRINCIPAL_ORG = '"iam"."principals"."org_id"';
const GROUP_ORG = '"org"."scim_groups"."org_id"';
const MEMBER_ORG = '"org"."scim_group_members"."org_id"';

/** The statement is fenced on this organization, and on no other value. */
function expectFenced(stmt: Stmt | undefined, column: string): void {
  expect(stmt, `no statement to check for ${column}`).toBeDefined();
  expect(boundTo(stmt!, column)).toEqual([ORG]);
}

/** A principal read's human, org-wide, not-deleted filter. */
function expectOrgUserFilter(stmt: Stmt | undefined): void {
  expectFenced(stmt, PRINCIPAL_ORG);
  expect(boundTo(stmt!, '"iam"."principals"."kind"')).toEqual(["human"]);
  expect(stmt!.sql).toContain('"iam"."principals"."workspace_id" is null');
  expect(stmt!.sql).toContain('"auth"."users"."deleted_at" is null');
  expect(stmt!.sql).toContain(
    `NOT ("iam"."principals"."metadata" ? 'scim_deleted_at')`,
  );
}

/** The one principal that is this person in this organization. */
function expectPrincipalOf(stmt: Stmt | undefined, userId: string): void {
  expectFenced(stmt, PRINCIPAL_ORG);
  expect(boundTo(stmt!, '"iam"."principals"."parent_user_id"')).toEqual([
    userId,
  ]);
  expect(boundTo(stmt!, '"iam"."principals"."kind"')).toEqual(["human"]);
  expect(stmt!.sql).toContain('"iam"."principals"."workspace_id" is null');
}

const find = (re: RegExp) => stmts.find((s) => re.test(s.sql));
const all = (re: RegExp) => stmts.filter((s) => re.test(s.sql));

/** A joined user row in the port's select-list order. */
function userRow(
  over: {
    id?: string;
    email?: string;
    displayName?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
    externalId?: string | null;
    metadata?: unknown;
    principalUpdatedAt?: Date;
  } = {},
): unknown[] {
  return [
    over.id ?? USER,
    over.email ?? "ada@acme.com",
    over.displayName === undefined ? "Ada Lovelace" : over.displayName,
    over.createdAt ?? T1,
    over.updatedAt ?? T1,
    over.externalId === undefined ? "00u1abcd" : over.externalId,
    over.metadata === undefined
      ? { scim: { givenName: "Ada", familyName: "Lovelace" } }
      : over.metadata,
    over.principalUpdatedAt ?? T1,
  ];
}

const groupRow = (
  id = GROUP,
  displayName = "Engineering",
  externalId: string | null = null,
) => [id, displayName, externalId, T1, T1];

beforeEach(() => {
  stmts = [];
  answers = [];
  for (const m of Object.values(lifecycle)) m.mockReset();
});

// ── Reads the service decides on ─────────────────────────────────────────────

describe("the organization's own settings", () => {
  it("reads only this organization's verified domains, lowercased", async () => {
    answers.push({
      match: /sso_providers/,
      rows: [["Acme.COM"], ["eu.acme.com"]],
    });
    await expect(store().verifiedDomains()).resolves.toEqual([
      "acme.com",
      "eu.acme.com",
    ]);
    const [stmt] = stmts;
    expectFenced(stmt, '"auth"."sso_providers"."organization_id"');
    expect(boundTo(stmt!, '"auth"."sso_providers"."domain_verified"')).toEqual([
      true,
    ]);
  });

  it("reads only this organization's group to role mappings", async () => {
    answers.push({
      match: /sso_group_roles/,
      rows: [["Oxagen Admins", "admin"]],
    });
    await expect(store().groupRoleMappings()).resolves.toEqual([
      { group: "Oxagen Admins", role: "admin" },
    ]);
    expectFenced(stmts[0], '"org"."sso_group_roles"."org_id"');
  });

  it("reads the role from this organization's membership, lowercased, or null", async () => {
    answers.push({ match: /org_users/, rows: [["Admin"]] });
    await expect(store().currentRole(USER)).resolves.toBe("admin");
    await expect(store().currentRole(USER)).resolves.toBeNull();
    for (const stmt of stmts) {
      expectFenced(stmt, '"org"."org_users"."org_id"');
      expect(boundTo(stmt, '"org"."org_users"."user_id"')).toEqual([USER]);
    }
  });
});

describe("users", () => {
  it("finds a person only through a human, org-wide principal of this organization", async () => {
    answers.push({ match: /from "iam"."principals"/, rows: [userRow()] });
    const row = await store().findUser(USER);
    expect(row).toEqual({
      id: USER,
      email: "ada@acme.com",
      displayName: "Ada Lovelace",
      givenName: "Ada",
      familyName: "Lovelace",
      externalId: "00u1abcd",
      active: true,
      createdAt: T1,
      updatedAt: T1,
    });
    expectOrgUserFilter(stmts[0]);
    expect(boundTo(stmts[0]!, '"auth"."users"."id"')).toEqual([USER]);
  });

  it("answers null when this organization has no such person", async () => {
    await expect(store().findUser(USER)).resolves.toBeNull();
    await expect(store().findUserByEmail("ada@acme.com")).resolves.toBeNull();
  });

  it("reads a deprovision marker as inactive, and the later of the two update times", async () => {
    answers.push({
      match: /from "iam"."principals"/,
      rows: [
        userRow({
          metadata: { scim_deprovisioned_at: "2026-09-23T12:00:00Z" },
          updatedAt: T1,
          principalUpdatedAt: T2,
          displayName: null,
        }),
      ],
    });
    const row = await store().findUser(USER);
    expect(row).toMatchObject({
      active: false,
      updatedAt: T2,
      displayName: null,
      // No `scim` name parts in the metadata reads as no name parts.
      givenName: null,
      familyName: null,
    });
  });

  it("ignores name parts that are not strings and metadata that is not an object", async () => {
    answers.push({
      match: /from "iam"."principals"/,
      rows: [
        userRow({
          metadata: { scim: { givenName: 7, familyName: "Lovelace" } },
        }),
      ],
    });
    answers.push({
      match: /from "iam"."principals"/,
      rows: [userRow({ metadata: null })],
    });
    expect(await store().findUser(USER)).toMatchObject({
      givenName: null,
      familyName: "Lovelace",
      active: true,
    });
    expect(await store().findUser(USER)).toMatchObject({
      givenName: null,
      familyName: null,
      active: true,
    });
  });

  it("looks a person up by email lowercased, inside this organization", async () => {
    answers.push({ match: /from "iam"."principals"/, rows: [userRow()] });
    await store().findUserByEmail("Ada@ACME.com");
    expectOrgUserFilter(stmts[0]);
    expect(boundTo(stmts[0]!, '"auth"."users"."email"')).toEqual([
      "ada@acme.com",
    ]);
  });
});

describe("listing users", () => {
  it("counts and pages under the same organization fence", async () => {
    answers.push({ match: /count\(\*\)/, rows: [[3]] });
    answers.push({
      match: /order by/,
      rows: [userRow(), userRow({ id: OTHER_USER })],
    });
    const out = await store().listUsers(null, 1, 2);
    expect(out.total).toBe(3);
    expect(out.rows.map((r) => r.id)).toEqual([USER, OTHER_USER]);
    expect(stmts).toHaveLength(2);
    for (const stmt of stmts) expectOrgUserFilter(stmt);
    const page = find(/order by/)!;
    expect(page.sql).toMatch(
      /order by "auth"."users"."created_at", "auth"."users"."id"/,
    );
    expect(page.sql).toMatch(/offset \$\d+/);
    expect(page.params.slice(-2)).toEqual([2, 1]);
  });

  it("answers the count alone for count=0, without reading a page", async () => {
    answers.push({ match: /count\(\*\)/, rows: [[5]] });
    const out = await store().listUsers(null, 0, 0);
    expect(out).toEqual({ rows: [], total: 5 });
    expect(stmts).toHaveLength(1);
  });

  it("answers a total of zero when the count comes back empty", async () => {
    await expect(store().listUsers(null, 0, 10)).resolves.toEqual({
      rows: [],
      total: 0,
    });
  });

  it.each([
    ["username", "Ada@Acme.com", '"auth"."users"."email"', "ada@acme.com"],
    ["emails.value", "ADA@acme.com", '"auth"."users"."email"', "ada@acme.com"],
    ["externalid", "00u1ABCD", '"iam"."principals"."idp_subject"', "00u1ABCD"],
    ["id", USER, '"auth"."users"."id"', USER],
  ])(
    "filters %s eq on its column, still inside the fence",
    async (attribute, value, column, bound) => {
      await store().listUsers({ attribute, value }, 0, 10);
      for (const stmt of stmts) {
        expectOrgUserFilter(stmt);
        expect(boundTo(stmt, column)).toEqual([bound]);
      }
    },
  );

  it.each(["not-a-uuid", "-".repeat(36), "0".repeat(36)])(
    "matches nobody for the id %s rather than failing the uuid cast",
    async (value) => {
      await store().listUsers({ attribute: "id", value }, 0, 10);
      for (const stmt of stmts) {
        expectOrgUserFilter(stmt);
        expect(stmt.sql).toMatch(/and false\)$|and false\) order by/);
        expect(stmt.params).not.toContain(value);
      }
    },
  );
});

describe("provisioning a user", () => {
  const name = {
    displayName: "Ada Lovelace",
    givenName: "Ada",
    familyName: "Lovelace",
  };

  it("creates the account and a human principal in this organization", async () => {
    answers.push({ match: /insert into "auth"."users"/, rows: [[USER]] });
    const out = await store().provisionUser({
      email: "ada@acme.com",
      name,
      externalId: "00u1",
    });
    expect(out).toEqual({ userId: USER, linked: false });

    const lookup = stmts[0]!;
    expect(lookup.sql).toMatch(
      /^select "id", "email_verified" from "auth"."users"/,
    );
    expect(boundTo(lookup, '"auth"."users"."email"')).toEqual(["ada@acme.com"]);
    expect(lookup.sql).toContain('"auth"."users"."deleted_at" is null');

    const account = find(/insert into "auth"."users"/)!;
    // The identity provider vouches for the address on a verified domain.
    expect(account.params).toEqual(
      expect.arrayContaining(["ada@acme.com", "Ada Lovelace", "active", true]),
    );

    expectPrincipalOf(find(/select "id" from "iam"."principals"/), USER);

    const principal = find(/insert into "iam"."principals"/)!;
    expect(principal.params).toEqual(
      expect.arrayContaining([
        ORG,
        "human",
        "Ada Lovelace",
        "active",
        USER,
        "00u1",
      ]),
    );
    expect(principal.params).toContainEqual(
      JSON.stringify({ scim: { givenName: "Ada", familyName: "Lovelace" } }),
    );
  });

  it("links an existing account and revives this organization's principal, clearing both SCIM markers", async () => {
    answers.push({ match: /from "auth"."users"/, rows: [[USER, true]] });
    answers.push({ match: /from "iam"."principals"/, rows: [["prn-1"]] });
    const out = await store().provisionUser({
      email: "ada@acme.com",
      name: { displayName: null, givenName: null, familyName: null },
      externalId: null,
    });
    expect(out).toEqual({ userId: USER, linked: true });
    expect(all(/insert into/)).toEqual([]);

    const update = find(/^update "iam"."principals"/)!;
    // The principal row it found, and only that row.
    expect(boundTo(update, '"iam"."principals"."id"')).toEqual(["prn-1"]);
    expect(update.sql).toContain(
      `("iam"."principals"."metadata" - 'scim_deprovisioned_at' - 'scim_deleted_at') ||`,
    );
    // No display name falls back to the email.
    expect(update.params).toEqual(
      expect.arrayContaining(["active", "ada@acme.com"]),
    );
  });

  it("links an unverified account only after dropping what its registration left", async () => {
    // Account pre-hijacking: someone registered the address without owning
    // the inbox. The identity provider now vouches for it, so the address is
    // verified and the squatter's password and sessions go.
    answers.push({ match: /from "auth"."users"/, rows: [[USER, false]] });
    answers.push({ match: /from "iam"."principals"/, rows: [["prn-1"]] });
    await store().provisionUser({
      email: "ada@acme.com",
      name: { displayName: null, givenName: null, familyName: null },
      externalId: null,
    });
    const verify = find(/^update "auth"."users"/)!;
    expect(boundTo(verify, '"auth"."users"."id"')).toEqual([USER]);
    expect(verify.params).toContain(true);
    const password = find(/^update "auth"."accounts"/)!;
    expect(boundTo(password, '"auth"."accounts"."user_id"')).toEqual([USER]);
    expect(boundTo(password, '"auth"."accounts"."provider_id"')).toEqual([
      "credential",
    ]);
    expect(password.sql).toContain('"password" = $');
    const sessions = find(/^delete from "auth"."sessions"/)!;
    expect(boundTo(sessions, '"auth"."sessions"."user_id"')).toEqual([USER]);
  });

  it("leaves a verified account's password and sessions alone", async () => {
    answers.push({ match: /from "auth"."users"/, rows: [[USER, true]] });
    answers.push({ match: /from "iam"."principals"/, rows: [["prn-1"]] });
    await store().provisionUser({
      email: "ada@acme.com",
      name: { displayName: null, givenName: null, familyName: null },
      externalId: null,
    });
    expect(find(/"auth"."accounts"/)).toBeUndefined();
    expect(find(/"auth"."sessions"/)).toBeUndefined();
    expect(find(/^update "auth"."users"/)).toBeUndefined();
  });

  it("throws when the account insert answers no row", async () => {
    await expect(
      store().provisionUser({ email: "ada@acme.com", name, externalId: null }),
    ).rejects.toThrow(/SCIM user insert returned no row/);
    expect(all(/iam"."principals"/)).toEqual([]);
  });
});

describe("updating a user", () => {
  it("refuses an email another account holds with a SCIM 409 and writes nothing", async () => {
    answers.push({ match: /from "auth"."users"/, rows: [[OTHER_USER]] });
    const err = await store()
      .setUserEmail(USER, "grace@acme.com")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScimError);
    expect(err).toMatchObject({ status: 409, scimType: "uniqueness" });
    expect(stmts).toHaveLength(1);
    expect(boundTo(stmts[0]!, '"auth"."users"."email"')).toEqual([
      "grace@acme.com",
    ]);
    expect(stmts[0]!.sql).toMatch(/"auth"."users"."id" <> \$\d/);
  });

  it("writes the new email to the one account", async () => {
    await store().setUserEmail(USER, "grace@acme.com");
    const update = find(/^update "auth"."users"/)!;
    expect(boundTo(update, '"auth"."users"."id"')).toEqual([USER]);
    expect(update.params).toContain("grace@acme.com");
  });

  it("writes the name to the account and to this organization's principal", async () => {
    await store().setUserName(
      USER,
      { displayName: "Ada King", givenName: "Ada", familyName: "King" },
      { account: true },
    );
    const account = find(/^update "auth"."users"/)!;
    expect(boundTo(account, '"auth"."users"."id"')).toEqual([USER]);
    const principal = find(/^update "iam"."principals"/)!;
    expectPrincipalOf(principal, USER);
    expect(principal.params).toContain("Ada King");
    expect(principal.params).toContainEqual(
      JSON.stringify({ scim: { givenName: "Ada", familyName: "King" } }),
    );
  });

  it("leaves the shared account alone for an identity the organization does not own", async () => {
    await store().setUserName(
      USER,
      { displayName: "Ada King", givenName: "Ada", familyName: "King" },
      { account: false },
    );
    expect(find(/^update "auth"."users"/)).toBeUndefined();
    const principal = find(/^update "iam"."principals"/)!;
    expectPrincipalOf(principal, USER);
    expect(principal.params).toContain("Ada King");
  });

  it("leaves the account's display name alone when none is sent", async () => {
    await store().setUserName(
      USER,
      { displayName: null, givenName: "Ada", familyName: null },
      { account: true },
    );
    expect(find(/^update "auth"."users"/)).toBeUndefined();
    const principal = find(/^update "iam"."principals"/)!;
    expectPrincipalOf(principal, USER);
    expect(principal.sql).not.toContain('"display_name"');
  });

  it("writes the external id to this organization's principal only", async () => {
    await store().setExternalId(USER, "00u9");
    expect(stmts).toHaveLength(1);
    expectPrincipalOf(stmts[0], USER);
    expect(stmts[0]!.params).toContain("00u9");
  });

  it("clears the deprovision marker on this organization's principal to reactivate", async () => {
    await store().reactivate(USER);
    expect(stmts).toHaveLength(1);
    expectPrincipalOf(stmts[0], USER);
    expect(stmts[0]!.sql).toContain(
      `"metadata" = "iam"."principals"."metadata" - 'scim_deprovisioned_at'`,
    );
    expect(stmts[0]!.params).toContain("active");
  });
});

describe("deprovisioning", () => {
  it("hands active: false to the shared removal transaction, fenced on this organization", async () => {
    await store().deprovision(USER, "scim_active_false", { endSessions: true });
    expect(lifecycle.removeOrgMemberInTx).toHaveBeenCalledTimes(1);
    expect(lifecycle.removeOrgMemberInTx.mock.calls[0]![1]).toEqual({
      orgId: ORG,
      userId: USER,
      actorId: null,
      trigger: "scim_active_false",
      endSessions: true,
      keys: "all",
      refuseOwner: true,
      principalStatus: "suspended",
      summaryEvent: "scim.user_deprovisioned",
      requestId: REQUEST_ID,
    });
    // Deactivation keeps group memberships and the person reads back.
    expect(stmts).toEqual([]);
  });

  it("on DELETE also drops this organization's memberships and marks the principal deleted", async () => {
    await store().deprovision(USER, "scim_delete", { endSessions: false });
    expect(lifecycle.removeOrgMemberInTx.mock.calls[0]![1]).toMatchObject({
      orgId: ORG,
      trigger: "scim_delete",
      // The service decides whether the organization owns the identity.
      endSessions: false,
    });
    const members = find(/^delete from "org"."scim_group_members"/)!;
    expectFenced(members, MEMBER_ORG);
    expect(boundTo(members, '"org"."scim_group_members"."user_id"')).toEqual([
      USER,
    ]);
    const marker = find(/^update "iam"."principals"/)!;
    expectPrincipalOf(marker, USER);
    expect(
      marker.params.some(
        (p) => typeof p === "string" && p.includes("scim_deleted_at"),
      ),
    ).toBe(true);
  });

  it("writes nothing of its own when the removal refuses", async () => {
    lifecycle.removeOrgMemberInTx.mockRejectedValueOnce(new Error("owner"));
    await expect(
      store().deprovision(USER, "scim_delete", { endSessions: true }),
    ).rejects.toThrow("owner");
    expect(stmts).toEqual([]);
  });

  it("asks the owner check about this organization", async () => {
    lifecycle.isOrgOwner.mockResolvedValue(true);
    await expect(store().isOwner(USER)).resolves.toBe(true);
    expect(lifecycle.isOrgOwner.mock.calls[0]!.slice(1)).toEqual([ORG, USER]);
  });

  it("applies a group's role through the mapped-role transaction as a SCIM group change", async () => {
    await store().applyRole(USER, "admin");
    expect(lifecycle.applyMappedOrgRoleInTx.mock.calls[0]![1]).toEqual({
      orgId: ORG,
      userId: USER,
      role: "admin",
      actorId: null,
      trigger: "scim_group_change",
      requestId: REQUEST_ID,
    });
  });
});

describe("group membership reads", () => {
  it("reads a person's groups with both tables fenced, and names each by display name and external id", async () => {
    answers.push({
      match: /scim_group_members/,
      rows: [
        ["Engineering", null],
        ["Oxagen Admins", "5f1b6c2e-8a44-4d4b-9d3e-0c7f2a1e9b10"],
      ],
    });
    await expect(store().groupNamesOf(USER)).resolves.toEqual([
      "Engineering",
      "Oxagen Admins",
      "5f1b6c2e-8a44-4d4b-9d3e-0c7f2a1e9b10",
    ]);
    const stmt = stmts[0]!;
    // The member row and the group row are each held to this organization, so
    // a member row that names another organization's group grants nothing.
    expectFenced(stmt, MEMBER_ORG);
    expectFenced(stmt, GROUP_ORG);
    expect(boundTo(stmt, '"org"."scim_group_members"."user_id"')).toEqual([
      USER,
    ]);
  });

  it("answers known users without a query for an empty list", async () => {
    await expect(store().knownUsers([])).resolves.toEqual(new Set());
    expect(stmts).toEqual([]);
  });

  it("keeps only people with a live human principal in this organization", async () => {
    answers.push({ match: /from "iam"."principals"/, rows: [[USER], [null]] });
    await expect(store().knownUsers([USER, OTHER_USER])).resolves.toEqual(
      new Set([USER]),
    );
    const stmt = stmts[0]!;
    expectFenced(stmt, PRINCIPAL_ORG);
    expect(boundTo(stmt, '"iam"."principals"."kind"')).toEqual(["human"]);
    expect(stmt.sql).toContain('"iam"."principals"."workspace_id" is null');
    expect(stmt.sql).toContain(
      `NOT ("iam"."principals"."metadata" ? 'scim_deleted_at')`,
    );
    expect(stmt.sql).toMatch(
      /"iam"."principals"."parent_user_id" in \(\$\d+, \$\d+\)/,
    );
    expect(stmt.params).toEqual(expect.arrayContaining([USER, OTHER_USER]));
  });

  it("reads a group's members inside this organization, shown by name or else email", async () => {
    answers.push({
      match: /scim_group_members/,
      rows: [
        [USER, "Ada Lovelace", "ada@acme.com"],
        [OTHER_USER, null, "grace@acme.com"],
      ],
    });
    await expect(store().groupMembers(GROUP)).resolves.toEqual([
      { userId: USER, display: "Ada Lovelace" },
      { userId: OTHER_USER, display: "grace@acme.com" },
    ]);
    expectFenced(stmts[0], MEMBER_ORG);
    expect(boundTo(stmts[0]!, '"org"."scim_group_members"."group_id"')).toEqual(
      [GROUP],
    );
  });
});

// ── Groups ───────────────────────────────────────────────────────────────────

describe("groups", () => {
  it("finds a group by id or by name inside this organization, or null", async () => {
    answers.push({ match: /scim_groups/, rows: [groupRow()] });
    await expect(store().findGroup(GROUP)).resolves.toEqual({
      id: GROUP,
      displayName: "Engineering",
      externalId: null,
      createdAt: T1,
      updatedAt: T1,
    });
    await expect(store().findGroupByName("Engineering")).resolves.toBeNull();
    expectFenced(stmts[0], GROUP_ORG);
    expect(boundTo(stmts[0]!, '"org"."scim_groups"."id"')).toEqual([GROUP]);
    expectFenced(stmts[1], GROUP_ORG);
    expect(boundTo(stmts[1]!, '"org"."scim_groups"."display_name"')).toEqual([
      "Engineering",
    ]);
  });

  it("counts and pages groups under the organization fence", async () => {
    answers.push({ match: /count\(\*\)/, rows: [[1]] });
    answers.push({ match: /order by/, rows: [groupRow()] });
    const out = await store().listGroups(null, 0, 10);
    expect(out).toMatchObject({ total: 1, rows: [{ id: GROUP }] });
    for (const stmt of stmts) expectFenced(stmt, GROUP_ORG);
  });

  it("answers the group count alone for count=0, and zero for an empty count", async () => {
    await expect(store().listGroups(null, 0, 0)).resolves.toEqual({
      rows: [],
      total: 0,
    });
    expect(stmts).toHaveLength(1);
  });

  it.each([
    [
      "displayname",
      "Engineering",
      '"org"."scim_groups"."display_name"',
      "Engineering",
    ],
    [
      "externalid",
      "okta-grp-1",
      '"org"."scim_groups"."external_id"',
      "okta-grp-1",
    ],
    ["id", GROUP, '"org"."scim_groups"."id"', GROUP],
  ])(
    "filters groups on %s, still inside the fence",
    async (attribute, value, column, bound) => {
      await store().listGroups({ attribute, value }, 0, 10);
      for (const stmt of stmts) {
        expectFenced(stmt, GROUP_ORG);
        expect(boundTo(stmt, column)).toEqual([bound]);
      }
    },
  );

  it.each(["grp-1", "-".repeat(36)])(
    "matches no group for the id %s",
    async (value) => {
      await store().listGroups({ attribute: "id", value }, 0, 10);
      for (const stmt of stmts) {
        expectFenced(stmt, GROUP_ORG);
        expect(stmt.params).not.toContain(value);
        expect(stmt.sql).toContain("and false)");
      }
    },
  );

  it("creates a group owned by this organization", async () => {
    answers.push({
      match: /insert into "org"."scim_groups"/,
      rows: [groupRow(GROUP, "Engineering", "okta-1")],
    });
    await expect(
      store().createGroup({ displayName: "Engineering", externalId: "okta-1" }),
    ).resolves.toMatchObject({ id: GROUP, externalId: "okta-1" });
    expect(stmts[0]!.params).toEqual(
      expect.arrayContaining([ORG, "Engineering", "okta-1"]),
    );
  });

  it("throws when the group insert answers no row", async () => {
    await expect(
      store().createGroup({ displayName: "Engineering", externalId: null }),
    ).rejects.toThrow(/SCIM group insert returned no row/);
  });

  it("renames and deletes only this organization's group", async () => {
    await store().updateGroup(GROUP, { displayName: "Eng" });
    await store().deleteGroup(GROUP);
    const update = find(/^update "org"."scim_groups"/)!;
    expectFenced(update, GROUP_ORG);
    expect(boundTo(update, '"org"."scim_groups"."id"')).toEqual([GROUP]);
    expect(update.params).toContain("Eng");
    const del = find(/^delete from "org"."scim_groups"/)!;
    expectFenced(del, GROUP_ORG);
    expect(boundTo(del, '"org"."scim_groups"."id"')).toEqual([GROUP]);
  });

  it("adds members as rows of this organization and touches the group", async () => {
    await store().addGroupMembers(GROUP, [USER, OTHER_USER]);
    const insert = find(/^insert into "org"."scim_group_members"/)!;
    expect(insert.sql).toContain("on conflict do nothing");
    // Two rows, each carrying (group, org, user).
    expect(insert.params).toEqual([GROUP, ORG, USER, GROUP, ORG, OTHER_USER]);
    const touch = find(/^update "org"."scim_groups"/)!;
    expectFenced(touch, GROUP_ORG);
    expect(boundTo(touch, '"org"."scim_groups"."id"')).toEqual([GROUP]);
  });

  it("removes only the named members of this organization's group and touches the group", async () => {
    await store().removeGroupMembers(GROUP, [USER]);
    const del = find(/^delete from "org"."scim_group_members"/)!;
    expectFenced(del, MEMBER_ORG);
    expect(boundTo(del, '"org"."scim_group_members"."group_id"')).toEqual([
      GROUP,
    ]);
    expect(del.sql).toMatch(
      /"org"."scim_group_members"."user_id" in \(\$\d+\)/,
    );
    expectFenced(find(/^update "org"."scim_groups"/), GROUP_ORG);
  });
});

describe("audit", () => {
  it("writes the scim.* row in the request's transaction, for this organization, with no actor", async () => {
    await store().audit("scim.user_provisioned", { userId: USER });
    expect(lifecycle.emitSecurityEventIn).toHaveBeenCalledTimes(1);
    expect(lifecycle.emitSecurityEventIn.mock.calls[0]![1]).toEqual({
      eventType: "scim.user_provisioned",
      actorUserId: null,
      orgId: ORG,
      workspaceId: null,
      capability: "execute_scim_request",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: REQUEST_ID,
      detail: { userId: USER },
    });
  });
});

describe("every statement the port sends", () => {
  it("binds this organization and never another, across a full request's worth of calls", async () => {
    const s = store();
    await s.verifiedDomains();
    await s.groupRoleMappings();
    await s.findUser(USER);
    await s.findUserByEmail("ada@acme.com");
    await s.listUsers({ attribute: "username", value: "ada@acme.com" }, 0, 10);
    await s.setUserName(
      USER,
      { displayName: null, givenName: null, familyName: null },
      { account: true },
    );
    await s.setExternalId(USER, null);
    await s.reactivate(USER);
    await s.currentRole(USER);
    await s.groupNamesOf(USER);
    await s.knownUsers([USER]);
    await s.findGroup(GROUP);
    await s.findGroupByName("Engineering");
    await s.listGroups(null, 0, 10);
    await s.updateGroup(GROUP, {});
    await s.deleteGroup(GROUP);
    await s.groupMembers(GROUP);
    await s.addGroupMembers(GROUP, [USER]);
    await s.removeGroupMembers(GROUP, [USER]);
    await s.deprovision(USER, "scim_delete", { endSessions: true });
    // Every statement that is not a read or write of the global account row
    // carries the organization as a bound value.
    const tenantStatements = stmts.filter(
      (st) => !/^(select [^]*? from|update) "auth"."users"/.test(st.sql),
    );
    expect(tenantStatements.length).toBeGreaterThan(20);
    for (const st of tenantStatements) {
      expect(st.params, st.sql).toContain(ORG);
    }
  });
});
