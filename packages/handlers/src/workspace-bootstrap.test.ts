import { describe, expect, it, vi, beforeEach } from "vitest";
import { schema, type Tx } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  bootstrapWorkspaceAgents: vi.fn(async () => undefined),
  seedWorkspaceDefaultRegistry: vi.fn(async () => "mreg_1"),
  seedWorkspaceDefaultEnvironment: vi.fn(async () => "env_1"),
}));

vi.mock("./workspace-agents", () => ({
  bootstrapWorkspaceAgents: mocks.bootstrapWorkspaceAgents,
}));
vi.mock("./workspace-registry-seed", () => ({
  seedWorkspaceDefaultRegistry: mocks.seedWorkspaceDefaultRegistry,
}));
vi.mock("./workspace-environment-seed", () => ({
  seedWorkspaceDefaultEnvironment: mocks.seedWorkspaceDefaultEnvironment,
}));

import { bootstrapWorkspace } from "./workspace-bootstrap";

const WS_ROW = {
  id: "ws_internal",
  publicId: "ws_pub",
  name: "Core",
  slug: "core",
  createdAt: new Date("2026-05-01T00:00:00Z"),
};

/** Whether a drizzle SQL tree binds `value` as a parameter. */
function binds(node: unknown, value: string, seen = new Set<unknown>()): boolean {
  if (node === value) return true;
  if (typeof node !== "object" || node === null || seen.has(node)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((n) => binds(n, value, seen));
  if ("queryChunks" in node) return binds(node.queryChunks, value, seen);
  if ("value" in node) return binds(node.value, value, seen);
  return false;
}

/** The step name each table a read or a write reaches is recorded under. */
function tableName(table: unknown): string {
  if (table === schema.workspaces) return "workspaces";
  if (table === schema.workspaceUsers) return "workspace_users";
  if (table === schema.principals) return "principals";
  if (table === schema.roles) return "roles";
  if (table === schema.principalRoleAssignments) return "assignments";
  return "other";
}

/** A fake transaction recording the values each insert receives. */
function makeTx(opts: {
  takenNamespaces?: string[];
  returning?: Array<typeof WS_ROW>;
  insertError?: Error;
  /** The creator's active human principal; null for none. */
  principal?: string | null;
  /** The org's workspace-scoped Owner role; null for none. */
  ownerRole?: string | null;
}) {
  const inserts: Array<Record<string, unknown>> = [];
  /** The table each entry of `inserts` went to. */
  const insertTables: string[] = [];
  /** The WHERE of each read, by table. */
  const reads = new Map<string, unknown>();
  /** Every statement the bootstrap runs directly on the transaction, in order. */
  const steps: string[] = [];
  const principal =
    opts.principal === undefined ? "prn_internal" : opts.principal;
  const ownerRole = opts.ownerRole === undefined ? "rol_ws_owner" : opts.ownerRole;
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals) return principal ? [{ id: principal }] : [];
    if (table === schema.roles) return ownerRole ? [{ id: ownerRole }] : [];
    return (opts.takenNamespaces ?? []).map((namespace) => ({ namespace }));
  };
  const tx = {
    execute: async () => {
      steps.push("execute");
      return undefined;
    },
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: unknown) => {
          const name = tableName(table);
          steps.push(`read ${name}`);
          reads.set(name, cond);
          const rows = rowsFor(table);
          return Object.assign(Promise.resolve(rows), {
            limit: async () => rows,
          });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if (opts.insertError) throw opts.insertError;
        inserts.push(v);
        insertTables.push(tableName(table));
        steps.push(`insert ${tableName(table)}`);
        return {
          returning: async () => opts.returning ?? [WS_ROW],
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve(undefined).then(res),
        };
      },
    }),
  };
  return { tx: tx as unknown as Tx, inserts, insertTables, reads, steps };
}

const ARGS = { orgId: "org_1", userId: "u_1", name: "Core", slug: "core" };

describe("bootstrapWorkspace", () => {
  beforeEach(() => {
    mocks.bootstrapWorkspaceAgents.mockClear();
    mocks.seedWorkspaceDefaultRegistry.mockClear();
    mocks.seedWorkspaceDefaultEnvironment.mockClear();
  });

  it("inserts the workspace with a namespace derived from the slug and the owner membership", async () => {
    const { tx, inserts } = makeTx({});
    const ws = await bootstrapWorkspace({ tx, ...ARGS });

    expect(ws).toEqual(WS_ROW);
    expect(inserts[0]).toEqual(
      expect.objectContaining({
        orgId: "org_1",
        name: "Core",
        slug: "core",
        namespace: "core",
        createdById: "u_1",
      }),
    );
    expect(inserts[1]).toEqual(
      expect.objectContaining({
        workspaceId: "ws_internal",
        userId: "u_1",
        role: "owner",
      }),
    );
  });

  it("avoids a namespace another workspace in the org already holds", async () => {
    const { tx, inserts } = makeTx({ takenNamespaces: ["core"] });
    await bootstrapWorkspace({ tx, ...ARGS });
    expect(inserts[0]?.namespace).not.toBe("core");
    expect(String(inserts[0]?.namespace)).toMatch(/^[a-z0-9]{2,6}$/);
  });

  it("seeds the agent, the registry and the environment on the same transaction", async () => {
    const { tx } = makeTx({});
    await bootstrapWorkspace({ tx, ...ARGS });

    const seeded = { orgId: "org_1", workspaceId: "ws_internal", tx };
    expect(mocks.bootstrapWorkspaceAgents).toHaveBeenCalledWith({
      ...seeded,
      userId: "u_1",
    });
    expect(mocks.seedWorkspaceDefaultRegistry).toHaveBeenCalledWith(seeded);
    expect(mocks.seedWorkspaceDefaultEnvironment).toHaveBeenCalledWith(seeded);
  });

  it("throws when the insert returns no row and seeds nothing", async () => {
    const { tx } = makeTx({ returning: [] });
    await expect(bootstrapWorkspace({ tx, ...ARGS })).rejects.toThrow(
      "workspace insert returned no row",
    );
    expect(mocks.bootstrapWorkspaceAgents).not.toHaveBeenCalled();
    expect(mocks.seedWorkspaceDefaultRegistry).not.toHaveBeenCalled();
    expect(mocks.seedWorkspaceDefaultEnvironment).not.toHaveBeenCalled();
  });

  // #3029: `create_workspace` runs on the CALLER's scope, and an org-only
  // caller's `app.current_workspace_id` is ORG_ONLY_WORKSPACE_ID (ADR-068) —
  // never the workspace being created. Every row after the workspace insert
  // lands in a workspace-GUC-scoped table, so the transaction's GUC has to move
  // to the new workspace between the two, or `tenant_isolation`'s WITH CHECK
  // refuses them with 42501. The principal read has to wait for the move too:
  // under the org-only value a read of `iam.principals` raises (ADR-086).
  it("re-points the transaction's workspace scope before writing any workspace-scoped row", async () => {
    const { tx, steps } = makeTx({});
    await bootstrapWorkspace({ tx, ...ARGS });

    expect(steps).toEqual([
      "read workspaces",
      "insert workspaces",
      "execute",
      "insert workspace_users",
      "read principals",
      "read roles",
      "insert assignments",
    ]);
  });

  it("does not re-point the scope when the workspace insert returned no row", async () => {
    const { tx, steps } = makeTx({ returning: [] });
    await expect(bootstrapWorkspace({ tx, ...ARGS })).rejects.toThrow(
      "workspace insert returned no row",
    );
    expect(steps).toEqual(["read workspaces", "insert workspaces"]);
  });

  // #5182: permission checks read IAM assignments, never workspace_users, so
  // the creator's Owner role has to be an assignment too.
  it("gives the creator's principal the org's workspace Owner role on the new workspace", async () => {
    const { tx, inserts, insertTables } = makeTx({});
    await bootstrapWorkspace({ tx, ...ARGS });

    expect(insertTables).toEqual(["workspaces", "workspace_users", "assignments"]);
    expect(inserts[2]).toEqual({
      principalId: "prn_internal",
      roleId: "rol_ws_owner",
      orgId: "org_1",
      workspaceId: "ws_internal",
      assignedBy: "u_1",
      createdById: "u_1",
      updatedById: "u_1",
    });
  });

  it("reads the creator's active human principal and the org's workspace-scoped Owner role", async () => {
    const { tx, reads } = makeTx({});
    await bootstrapWorkspace({ tx, ...ARGS });

    const principal = reads.get("principals");
    for (const value of ["org_1", "u_1", "human", "active"])
      expect(binds(principal, value)).toBe(true);
    const role = reads.get("roles");
    for (const value of ["org_1", "workspace", "Owner"])
      expect(binds(role, value)).toBe(true);
  });

  it("throws and assigns nothing when the creator has no active principal in the org", async () => {
    const { tx, insertTables } = makeTx({ principal: null });
    await expect(bootstrapWorkspace({ tx, ...ARGS })).rejects.toThrow(
      "user u_1 has no active principal in org org_1",
    );
    expect(insertTables).not.toContain("assignments");
    expect(mocks.bootstrapWorkspaceAgents).not.toHaveBeenCalled();
  });

  it("throws and assigns nothing when the org has no workspace Owner role", async () => {
    const { tx, insertTables } = makeTx({ ownerRole: null });
    await expect(bootstrapWorkspace({ tx, ...ARGS })).rejects.toThrow(
      "org org_1 has no workspace Owner role",
    );
    expect(insertTables).not.toContain("assignments");
    expect(mocks.bootstrapWorkspaceAgents).not.toHaveBeenCalled();
  });

  it("lets a unique violation reach the caller unchanged", async () => {
    const dup = Object.assign(new Error("dup"), { code: "23505" });
    const { tx } = makeTx({ insertError: dup });
    await expect(bootstrapWorkspace({ tx, ...ARGS })).rejects.toBe(dup);
  });
});
