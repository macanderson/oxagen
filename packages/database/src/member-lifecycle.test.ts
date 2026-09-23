/**
 * The member removal transaction (#3734, #3740 item 2).
 *
 * A fake transaction records every statement, compiled through PgDialect so
 * the assertions read the WHERE clause the database would run, and answers
 * each read from a small table of rows keyed by the table it names.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyMappedOrgRoleInTx,
  OwnerRemovalRefused,
  removeOrgMemberInTx,
  type RemoveOrgMemberOptions,
} from "./member-lifecycle";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-0000000000aa";
const WS = "00000000-0000-0000-0000-0000000000c1";
const HOST = {
  id: "host-row",
  publicId: "tch_0123456789abcdefghjkmn",
  apiKeyId: "host-key",
  workspaceId: WS,
};

const dialect = new PgDialect();

interface Stmt {
  op: "select" | "update" | "delete" | "insert";
  table: string;
  sql: string;
  params: readonly unknown[];
  values?: Record<string, unknown>;
}

let stmts: Stmt[];
/** Rows a statement answers with, by op and table. */
let rows: Partial<Record<string, unknown[]>>;
/** Answers consumed in order before `rows`, for a table read more than once. */
let queued: Partial<Record<string, unknown[][]>>;

function tableNameOf(table: unknown): string {
  for (const s of Object.getOwnPropertySymbols(table as object)) {
    const v = (table as Record<symbol, unknown>)[s];
    if (typeof v === "string" && v !== "") return v;
  }
  return "unknown";
}

function answer(op: Stmt["op"], table: string): unknown[] {
  const key = `${op}:${table}`;
  const next = queued[key]?.shift();
  return next ?? rows[key] ?? [];
}

/** A chainable, awaitable stand-in for one Drizzle query. */
function query(op: Stmt["op"], table: string, values?: object) {
  const stmt: Stmt = {
    op,
    table,
    sql: "",
    params: [],
    values: values as Record<string, unknown>,
  };
  stmts.push(stmt);
  const q: Record<string, unknown> = {};
  const self = () => q;
  q.from = (t: unknown) => {
    stmt.table = tableNameOf(t);
    return q;
  };
  q.innerJoin = self;
  q.limit = self;
  q.for = self;
  q.set = (v: object) => {
    stmt.values = v as Record<string, unknown>;
    return q;
  };
  q.values = (v: object) => {
    stmt.values = v as Record<string, unknown>;
    return q;
  };
  q.onConflictDoNothing = self;
  q.onConflictDoUpdate = self;
  q.returning = self;
  q.where = (pred: SQL) => {
    const compiled = dialect.sqlToQuery(pred);
    stmt.sql = compiled.sql;
    stmt.params = compiled.params;
    return q;
  };
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(answer(op, stmt.table)).then(resolve, reject);
  return q;
}

function fakeTx() {
  return {
    select: () => query("select", "unknown"),
    update: (t: unknown) => query("update", tableNameOf(t)),
    delete: (t: unknown) => query("delete", tableNameOf(t)),
    insert: (t: unknown) => query("insert", tableNameOf(t)),
  };
}

const events = () =>
  stmts
    .filter((s) => s.op === "insert" && s.table === "security_events")
    .map((s) => s.values as { eventType: string; detail?: unknown });

const deprovision = (
  over: Partial<RemoveOrgMemberOptions> = {},
): RemoveOrgMemberOptions => ({
  orgId: ORG,
  userId: USER,
  actorId: null,
  trigger: "scim_delete",
  endSessions: true,
  keys: "all",
  refuseOwner: true,
  principalStatus: "suspended",
  summaryEvent: "scim.user_deprovisioned",
  now: new Date("2026-09-23T12:00:00Z"),
  ...over,
});

beforeEach(() => {
  stmts = [];
  queued = {};
  rows = {
    "select:org_users": [{ role: "member" }],
    "select:principals": [{ id: "prn-1" }],
    "update:principal_role_assignments": [{ id: "pra-1" }, { id: "pra-2" }],
    "delete:org_users": [{ id: "ou-1" }],
    "select:workspaces": [{ id: WS }],
    "delete:workspace_users": [{ id: "wu-1" }],
    "select:hosts": [HOST],
    "select:api_keys": [
      { id: "host-key", scope: { purpose: "tacho_host_v1" } },
      { id: "gateway-key", scope: { purpose: "tacho_gateway_v1" } },
    ],
    "update:enrollment_tokens": [{ id: "tet-1" }],
    "update:api_keys": [
      { id: "plain-key", scope: {} },
      { id: "cli-key", scope: { purpose: "cli_session_v1" } },
      { id: "agent-key", scope: { purpose: "agent_credential_v1" } },
      { id: "stella-key", scope: { purpose: "stella_operational_telemetry_v1" } },
    ],
    "delete:sessions": [{ id: "sess-1" }, { id: "sess-2" }],
  };
});

describe("removeOrgMemberInTx — a SCIM deprovision", () => {
  it("ends every session, revokes every key and host, and removes the membership", async () => {
    const result = await removeOrgMemberInTx(fakeTx() as never, deprovision());

    expect(result.sessionIds).toEqual(["sess-1", "sess-2"]);
    expect(result.apiKeyIds.sort()).toEqual(
      [
        "agent-key",
        "cli-key",
        "gateway-key",
        "host-key",
        "plain-key",
        "stella-key",
      ].sort(),
    );
    expect(result.hostIds).toEqual([HOST.publicId]);
    expect(result.enrollmentTokensExpired).toBe(1);
    expect(result.roleAssignmentsRevoked).toBe(2);
    expect(result.workspaceMembershipsRemoved).toBe(1);
    expect(result.wasMember).toBe(true);

    // Sessions are deleted by user, across every organization.
    const sessions = stmts.find((s) => s.op === "delete" && s.table === "sessions");
    expect(sessions?.params).toEqual([USER]);

    // Role assignments at every scope: no workspace predicate.
    const pra = stmts.find(
      (s) => s.op === "update" && s.table === "principal_role_assignments",
    );
    expect(pra?.sql).not.toContain("workspace_id");
    expect(pra?.params).toContain(ORG);

    // The creator sweep carries no purpose filter, so machine keys go too.
    const sweep = stmts.find(
      (s) =>
        s.op === "update" &&
        s.table === "api_keys" &&
        s.sql.includes("created_by_id"),
    );
    expect(sweep?.sql).not.toContain("purpose");
    expect(sweep?.params).toEqual(expect.arrayContaining([ORG, USER]));

    // The host went through revokeHostEnrollment: revoked row and a command.
    const host = stmts.find((s) => s.op === "update" && s.table === "hosts");
    expect(host?.values).toMatchObject({ status: "revoked" });
    expect(
      stmts.some((s) => s.op === "insert" && s.table === "control_commands"),
    ).toBe(true);

    // An unused enrollment token issued to the person expires now.
    const tokens = stmts.find(
      (s) => s.op === "update" && s.table === "enrollment_tokens",
    );
    expect(tokens?.values).toMatchObject({ expiresAt: deprovision().now });
    expect(tokens?.sql).toContain("used_at");

    // The principal is suspended with the SCIM marker, so an SSO sign-in
    // cannot re-admit the person.
    const principal = stmts.find(
      (s) => s.op === "update" && s.table === "principals",
    );
    expect(principal?.values).toMatchObject({ status: "suspended" });
  });

  it("writes one row per ended session and revoked credential, then the summary", async () => {
    await removeOrgMemberInTx(fakeTx() as never, deprovision());
    const types = events().map((e) => e.eventType);
    expect(types.filter((t) => t === "auth.sign_out")).toHaveLength(2);
    expect(types.filter((t) => t === "security.session_revoked")).toHaveLength(2);
    expect(types.filter((t) => t === "api_key.revoked")).toHaveLength(6);
    expect(types.filter((t) => t === "tacho.host_revoked")).toHaveLength(1);
    expect(types.at(-1)).toBe("scim.user_deprovisioned");
    expect(events().at(-1)?.detail).toMatchObject({
      userId: USER,
      trigger: "scim_delete",
      sessionsEnded: 2,
      apiKeysRevoked: 6,
      hostsRevoked: 1,
      enrollmentTokensExpired: 1,
    });
  });

  it("refuses an Owner before writing anything", async () => {
    rows["select:org_users"] = [{ role: "Owner" }];
    await expect(
      removeOrgMemberInTx(fakeTx() as never, deprovision()),
    ).rejects.toBeInstanceOf(OwnerRemovalRefused);
    expect(stmts.filter((s) => s.op !== "select")).toEqual([]);
  });

  it("refuses an Owner held only through an IAM assignment", async () => {
    rows["select:org_users"] = [{ role: "member" }];
    // The owner probe joins principal_role_assignments; the fake answers it
    // from its FROM table.
    rows["select:principal_role_assignments"] = [{ id: "owner-pra" }];
    await expect(
      removeOrgMemberInTx(fakeTx() as never, deprovision()),
    ).rejects.toBeInstanceOf(OwnerRemovalRefused);
  });
});

describe("removeOrgMemberInTx — a manual removal", () => {
  it("keeps sessions, revokes only CLI session keys, and writes no summary", async () => {
    rows["select:hosts"] = [];
    rows["update:api_keys"] = [
      { id: "cli-key", scope: { purpose: "cli_session_v1" } },
    ];
    const result = await removeOrgMemberInTx(
      fakeTx() as never,
      deprovision({
        trigger: "manual",
        actorId: "admin-1",
        endSessions: false,
        keys: "cli_sessions",
        refuseOwner: false,
        principalStatus: "deleted",
        summaryEvent: null,
      }),
    );
    expect(result.sessionIds).toEqual([]);
    expect(stmts.some((s) => s.table === "sessions")).toBe(false);
    expect(stmts.some((s) => s.table === "hosts")).toBe(false);
    const sweep = stmts.find((s) => s.op === "update" && s.table === "api_keys");
    expect(sweep?.sql).toContain("purpose");
    expect(sweep?.params).toContain("cli_session_v1");
    expect(events().map((e) => e.eventType)).toEqual(["api_key.revoked"]);
    expect(events()[0]?.detail).toBeUndefined();
  });
});

describe("applyMappedOrgRoleInTx", () => {
  it("never changes an Owner", async () => {
    rows["select:org_users"] = [{ role: "owner" }];
    const out = await applyMappedOrgRoleInTx(fakeTx() as never, {
      orgId: ORG,
      userId: USER,
      role: null,
      actorId: USER,
      trigger: "sso_deny",
    });
    expect(out).toEqual({ kind: "owner_unmanaged" });
    expect(stmts.filter((s) => s.op !== "select")).toEqual([]);
  });

  it("never changes an Owner held only through an IAM assignment", async () => {
    rows["select:org_users"] = [{ role: "member" }];
    rows["select:principal_role_assignments"] = [{ id: "owner-pra" }];
    const out = await applyMappedOrgRoleInTx(fakeTx() as never, {
      orgId: ORG,
      userId: USER,
      role: null,
      actorId: null,
      trigger: "scim_group_change",
    });
    expect(out).toEqual({ kind: "owner_unmanaged" });
    expect(stmts.filter((s) => s.op !== "select")).toEqual([]);
  });

  it("turns no mapped role into a full removal that leaves sessions alone", async () => {
    const out = await applyMappedOrgRoleInTx(fakeTx() as never, {
      orgId: ORG,
      userId: USER,
      role: null,
      actorId: USER,
      trigger: "sso_deny",
    });
    expect(out.kind).toBe("removed");
    // Workspace membership and every key go, which the deny path used to keep.
    expect(
      stmts.some((s) => s.op === "delete" && s.table === "workspace_users"),
    ).toBe(true);
    expect(
      stmts.some(
        (s) =>
          s.op === "update" &&
          s.table === "api_keys" &&
          s.sql.includes("created_by_id") &&
          !s.sql.includes("purpose"),
      ),
    ).toBe(true);
    expect(stmts.some((s) => s.table === "sessions")).toBe(false);
    const summary = events().at(-1);
    expect(summary?.eventType).toBe("org.member_removed");
    expect(summary?.detail).toMatchObject({ trigger: "sso_deny" });
  });

  it("does not re-admit a person a SCIM deprovision suspended", async () => {
    rows["select:org_users"] = [];
    rows["select:principals"] = [
      {
        id: "prn-1",
        status: "suspended",
        metadata: { scim_deprovisioned_at: "2026-09-23T12:00:00Z" },
      },
    ];
    const out = await applyMappedOrgRoleInTx(fakeTx() as never, {
      orgId: ORG,
      userId: USER,
      role: "admin",
      actorId: USER,
      trigger: "sso_deny",
    });
    expect(out).toEqual({ kind: "scim_suspended" });
    expect(stmts.filter((s) => s.op !== "select")).toEqual([]);
  });

  it("grants a mapped role and upserts the membership", async () => {
    rows["select:principals"] = [
      { id: "prn-1", status: "active", metadata: {} },
    ];
    rows["select:roles"] = [{ id: "role-admin" }];
    // The first read is the Owner probe, which must find no Owner assignment.
    queued["select:principal_role_assignments"] = [[]];
    rows["select:principal_role_assignments"] = [{ id: "pra-new" }];
    const out = await applyMappedOrgRoleInTx(fakeTx() as never, {
      orgId: ORG,
      userId: USER,
      role: "admin",
      actorId: null,
      trigger: "scim_group_change",
    });
    expect(out).toEqual({ kind: "granted", role: "admin" });
    const membership = stmts.find(
      (s) => s.op === "insert" && s.table === "org_users",
    );
    expect(membership?.values).toMatchObject({ orgId: ORG, userId: USER, role: "admin" });
  });

  it("creates the principal when none exists, named after the user", async () => {
    rows["select:org_users"] = [];
    queued["select:principals"] = [[]];
    rows["select:principals"] = [{ id: "prn-new", status: "active", metadata: {} }];
    rows["select:users"] = [{ displayName: null, email: "ada@acme.com" }];
    rows["select:roles"] = [{ id: "role-admin" }];
    // The first read is the Owner probe, which must find no Owner assignment.
    queued["select:principal_role_assignments"] = [[]];
    rows["select:principal_role_assignments"] = [{ id: "pra-new" }];
    await applyMappedOrgRoleInTx(fakeTx() as never, {
      orgId: ORG,
      userId: USER,
      role: "admin",
      actorId: null,
      trigger: "scim_group_change",
    });
    const principal = stmts.find(
      (s) => s.op === "insert" && s.table === "principals",
    );
    expect(principal?.values).toMatchObject({
      orgId: ORG,
      kind: "human",
      displayName: "ada@acme.com",
      parentUserId: USER,
      status: "active",
    });
  });

  it("maps member to a membership with no org-wide role", async () => {
    rows["select:principals"] = [{ id: "prn-1", status: "active", metadata: {} }];
    await applyMappedOrgRoleInTx(fakeTx() as never, {
      orgId: ORG,
      userId: USER,
      role: "member",
      actorId: null,
      trigger: "scim_group_change",
    });
    expect(
      stmts.some(
        (s) => s.op === "insert" && s.table === "principal_role_assignments",
      ),
    ).toBe(false);
    expect(
      stmts.find((s) => s.op === "insert" && s.table === "org_users")?.values,
    ).toMatchObject({ role: "member" });
  });

  it("throws when the grant did not take, so the caller's transaction rolls back", async () => {
    rows["select:principals"] = [{ id: "prn-1", status: "active", metadata: {} }];
    rows["select:roles"] = [{ id: "role-admin" }];
    rows["select:principal_role_assignments"] = [];
    await expect(
      applyMappedOrgRoleInTx(fakeTx() as never, {
        orgId: ORG,
        userId: USER,
        role: "admin",
        actorId: null,
        trigger: "scim_group_change",
      }),
    ).rejects.toThrow(/did not take/);
  });

  it("throws when the organization has no such IAM role", async () => {
    rows["select:principals"] = [{ id: "prn-1", status: "active", metadata: {} }];
    rows["select:roles"] = [];
    await expect(
      applyMappedOrgRoleInTx(fakeTx() as never, {
        orgId: ORG,
        userId: USER,
        role: "compliance",
        actorId: null,
        trigger: "scim_group_change",
      }),
    ).rejects.toThrow(/No 'Compliance' org role/);
  });

  it("reactivates a principal a manual removal marked deleted", async () => {
    rows["select:org_users"] = [];
    rows["select:principals"] = [{ id: "prn-1", status: "deleted", metadata: {} }];
    await applyMappedOrgRoleInTx(fakeTx() as never, {
      orgId: ORG,
      userId: USER,
      role: "member",
      actorId: null,
      trigger: "scim_group_change",
    });
    expect(
      stmts.find((s) => s.op === "update" && s.table === "principals")?.values,
    ).toMatchObject({ status: "active" });
  });
});

describe("removeOrgMemberInTx — edges", () => {
  it("skips the workspace sweep when the organization has no workspaces", async () => {
    rows["select:workspaces"] = [];
    const result = await removeOrgMemberInTx(fakeTx() as never, deprovision());
    expect(result.workspaceMembershipsRemoved).toBe(0);
    expect(stmts.some((s) => s.table === "workspace_users")).toBe(false);
  });

  it("reports wasMember false when the person held nothing here", async () => {
    rows["select:principals"] = [];
    rows["delete:org_users"] = [];
    rows["delete:workspace_users"] = [];
    const result = await removeOrgMemberInTx(fakeTx() as never, deprovision());
    expect(result.wasMember).toBe(false);
    expect(result.roleAssignmentsRevoked).toBe(0);
  });
});
