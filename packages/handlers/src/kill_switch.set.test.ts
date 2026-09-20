/**
 * Unit tests for the set_kill_switch handler (spec §6.11, #2958).
 *
 * The org is tier-free in every case: the kernel's IAM check allows every
 * capability there, so the refusals come from the handler alone. The role
 * gate runs for real against a tx double that answers the principal and
 * role-assignment tables. The flip runs for real against a second tx double
 * that models iam.emergency_denies, mcp.credential_grants and
 * iam.authorization_deny_generations — including the table's AFTER trigger:
 * every row written to emergency_denies bumps the generation the double
 * answers from then on, so a handler that read the generation on another
 * transaction or before its write would return the old vector — and the
 * partial unique index over a target's active row: an INSERT while the
 * double holds an active row for the target conflicts and writes nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import { resourceScopeDigestOf } from "@oxagen/iam";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  withOrgDb: vi.fn(),
  emitSecurityEvent: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // Separate spies expose which write scope the production handler chooses.
  // The default org mock forwards role reads to the shared fixture.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: mocks.withOrgDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEvent: mocks.emitSecurityEvent,
}));

import {
  createKillSwitchSetHandler,
  killSwitchSetHandler,
  resolveKillSwitchTarget,
  type KillSwitchTargetLookups,
} from "./kill_switch.set";
import { makeCTX } from "./test-utils/fixtures";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const USER_PUBLIC_ID = "usr_finops1";
const SERVER = "0192d4a8-7c1e-7a00-8000-0000000000aa";
const CONNECTION = "0192d4a8-7c1e-7a00-8000-0000000000bb";
/** A second workspace of the same organisation. */
const OTHER_WS = "0192d4a8-7c1e-7a00-8000-00000000ac41";

const ctx = (over: { userId?: string | null } = {}) =>
  makeCTX({ orgId: ORG, workspaceId: WS, userId: USER, ...over });

// ── role-gate tx double ───────────────────────────────────────────────────────

function stubRole(roleName: string | null) {
  const rowsFor = (table: unknown): unknown[] => {
    if (table === schema.principals) return [{ id: "prn_1" }];
    if (table === schema.principalRoleAssignments)
      return roleName ? [{ roleName }] : [];
    throw new Error("unexpected table");
  };
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () => Promise.resolve(rowsFor(table)),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

// ── the flip transaction double ──────────────────────────────────────────────

type Op =
  | { op: "select"; table: unknown }
  | {
      op: "insert";
      table: unknown;
      values: Record<string, unknown>;
      conflict: { target: unknown[]; where: SQL } | null;
    }
  | { op: "update"; table: unknown; set: Record<string, unknown>; cond: SQL };

const sqlOf = (s: SQL) => new PgDialect().sqlToQuery(s).sql;

function flipTx(state: {
  generation: number;
  /** The target's active rows; more than one models two on-flips that raced before the unique index existed. */
  activeSwitches: { id: string; publicId: string }[];
  liveGrants: number;
}) {
  const ops: Op[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        ops.push({ op: "select", table });
        const rows = () => {
          if (table === schema.emergencyDenies) return state.activeSwitches;
          if (table === schema.authorizationDenyGenerations)
            return [{ workspaceId: null, generation: state.generation }];
          throw new Error("unexpected table");
        };
        const chain = {
          where: () => chain,
          limit: () => Promise.resolve(rows()),
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rows()).then(res, rej),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const op: Op = { op: "insert", table, values, conflict: null };
        ops.push(op);
        const returning = () => {
          if (table !== schema.emergencyDenies)
            throw new Error("unexpected table");
          // The partial unique index: an active row for the target conflicts.
          if (op.conflict && state.activeSwitches.length > 0)
            return Promise.resolve([]);
          state.generation += 1; // the trigger
          return Promise.resolve([{ publicId: "emd_new" }]);
        };
        return {
          returning,
          onConflictDoNothing: (conflict: {
            target: unknown[];
            where: SQL;
          }) => {
            op.conflict = conflict;
            return { returning };
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (cond: SQL) => {
          ops.push({ op: "update", table, set, cond });
          const rows = () => {
            if (table === schema.emergencyDenies) {
              const hit = state.activeSwitches;
              state.activeSwitches = [];
              state.generation += hit.length; // the trigger, per row
              return hit;
            }
            return Array.from({ length: state.liveGrants }, (_, i) => ({
              id: `g${i}`,
            }));
          };
          return {
            returning: () => Promise.resolve(rows()),
            then: (
              res: (v: unknown) => unknown,
              rej: (e: unknown) => unknown,
            ) => Promise.resolve(rows()).then(res, rej),
          };
        },
      }),
    }),
  };
  return { tx, ops, state };
}

const lookups: KillSwitchTargetLookups = {
  toolVersion: async (_s, id) =>
    id === "tlv_pay" ? { capabilityId: `mcp.${SERVER}.create_payment` } : null,
  mcpServer: async (_s, id) => (id === "mcs_github" ? { id: SERVER } : null),
  connection: async (_s, id) => (id === "mcrd_gh" ? { id: CONNECTION } : null),
  agent: async (_s, id) => (id === "agt_finops" ? { publicId: id } : null),
  resolveOperator: async (_o, idOrPublicId) =>
    idOrPublicId === USER || idOrPublicId === USER_PUBLIC_ID
      ? { userId: USER, publicId: USER_PUBLIC_ID }
      : null,
  workspace: async (_o, wsId) => wsId === WS || wsId === OTHER_WS,
};

function handlerOver(flip: ReturnType<typeof flipTx>) {
  return createKillSwitchSetHandler({
    lookups,
    transaction: (fn) => fn(flip.tx as never),
  });
}

beforeEach(() => {
  mocks.emitSecurityEvent.mockReset();
  stubRole("Owner");
  mocks.withOrgDb.mockReset();
  mocks.withOrgDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    mocks.withTenantDb(fn),
  );
});

describe("resolveKillSwitchTarget", () => {
  const scope = { orgId: ORG, workspaceId: WS };

  it("a tool version becomes a capability deny on the id its calls are governed under", async () => {
    const r = await resolveKillSwitchTarget(lookups, scope, {
      kind: "tool_version",
      id: "tlv_pay",
    });
    expect(r).toEqual({
      deny: {
        kind: "capability",
        capabilityId: `mcp.${SERVER}.create_payment`,
      },
      connectionId: null,
    });
  });

  it.each([
    ["tool_server", "mcs_github", "tool_server", SERVER],
    ["connection", "mcrd_gh", "connection", CONNECTION],
    ["agent", "agt_finops", "agent", "agt_finops"],
    ["operator", USER, "operator", USER],
    ["operator", USER_PUBLIC_ID, "operator", USER],
    ["workspace", WS, "workspace", WS],
    ["workspace", OTHER_WS, "workspace", OTHER_WS],
    ["org", ORG, "org", ORG],
    ["class", "moves_money", "class", "moves_money"],
  ] as const)(
    "a %s target becomes a resource_scope deny over the same {kind, id} the live checks derive",
    async (kind, id, digestKind, digestId) => {
      const r = await resolveKillSwitchTarget(lookups, scope, {
        kind,
        id,
      } as never);
      expect(r.deny).toEqual({
        kind: "resource_scope",
        digest: resourceScopeDigestOf({ kind: digestKind, id: digestId }),
      });
      expect(r.connectionId).toBe(kind === "connection" ? CONNECTION : null);
    },
  );

  it.each([
    ["tool_version", "tlv_missing"],
    ["tool_server", "mcs_missing"],
    ["connection", "mcrd_missing"],
    ["agent", "agt_missing"],
    ["operator", "0192d4a8-7c1e-7a00-8000-0000000005e2"],
    ["operator", "usr_missing"],
    ["workspace", "0192d4a8-7c1e-7a00-8000-00000000ac42"],
  ] as const)("an unknown %s is not_found", async (kind, id) => {
    await expect(
      resolveKillSwitchTarget(lookups, scope, { kind, id } as never),
    ).rejects.toMatchObject({ code: "not_found", reason: `${kind}_not_found` });
  });

  it("another organisation is forbidden", async () => {
    await expect(
      resolveKillSwitchTarget(lookups, scope, {
        kind: "org",
        id: "0192d4a8-7c1e-7a00-8000-00000000ac3f",
      }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "other_org" });
  });
});

describe("set_kill_switch", () => {
  it("flips a class switch on: writes the org-wide row and returns the generation bumped in the same transaction", async () => {
    const flip = flipTx({ generation: 4, activeSwitches: [], liveGrants: 0 });
    const out = await handlerOver(flip)(
      {
        target: { kind: "class", id: "moves_money" },
        on: true,
        reason: "processor incident",
      },
      ctx(),
    );

    expect(out).toEqual({
      switchId: "emd_new",
      on: true,
      changed: true,
      denyGeneration: { org: 5, workspace: 0 },
      grantsRevoked: 0,
    });
    const insert = flip.ops.find((o) => o.op === "insert");
    expect(
      insert && insert.op === "insert" ? insert.values : null,
    ).toMatchObject({
      orgId: ORG,
      workspaceId: null,
      scopeKind: "org",
      denyKind: "resource_scope",
      resourceScopeDigest: resourceScopeDigestOf({
        kind: "class",
        id: "moves_money",
      }),
      capabilityId: null,
      targetKind: "class",
      targetId: "moves_money",
      flippedByUserId: USER,
      reason: "processor incident",
      active: true,
    });
    // The insert is ON CONFLICT DO NOTHING against the org-wide active-target
    // index, so a concurrent on-flip of the same class writes one row.
    const conflict = insert && insert.op === "insert" ? insert.conflict : null;
    expect(conflict?.target).toEqual([
      schema.emergencyDenies.orgId,
      schema.emergencyDenies.targetKind,
      schema.emergencyDenies.targetId,
    ]);
    expect(conflict ? sqlOf(conflict.where) : null).toBe(
      "active = true AND workspace_id IS NULL",
    );
    // The generation read follows the write on the same transaction.
    const kinds = flip.ops.map(
      (o) =>
        `${o.op}:${o.table === schema.emergencyDenies ? "denies" : o.table === schema.authorizationDenyGenerations ? "generations" : "other"}`,
    );
    expect(kinds.indexOf("insert:denies")).toBeLessThan(
      kinds.lastIndexOf("select:generations"),
    );
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "tool.kill_switch_flipped",
        actorUserId: USER,
        orgId: ORG,
        workspaceId: null,
        capability: "set_kill_switch",
        outcome: "success",
      }),
    );
  });

  it.each([
    ["tool_version", "tlv_pay", WS],
    ["tool_server", "mcs_github", WS],
    ["connection", "mcrd_gh", WS],
    ["agent", "agt_finops", WS],
    ["operator", USER, null],
    ["workspace", OTHER_WS, null],
    ["org", ORG, null],
    ["class", "moves_money", null],
  ] as const)(
    "a %s switch is written under workspace %s",
    async (kind, id, workspaceId) => {
      const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
      await handlerOver(flip)(
        { target: { kind, id }, on: true, reason: "x" },
        ctx(),
      );
      const insert = flip.ops.find((o) => o.op === "insert");
      expect(
        insert && insert.op === "insert" ? insert.values.workspaceId : "none",
      ).toBe(workspaceId);
    },
  );

  it("flips a tool version on as a capability deny in the workspace", async () => {
    const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
    const out = await handlerOver(flip)(
      {
        target: { kind: "tool_version", id: "tlv_pay" },
        on: true,
        reason: "bad version",
      },
      ctx(),
    );
    expect(out.denyGeneration).toEqual({ org: 2, workspace: 0 });
    const insert = flip.ops.find((o) => o.op === "insert");
    expect(
      insert && insert.op === "insert" ? insert.values : null,
    ).toMatchObject({
      workspaceId: WS,
      scopeKind: "workspace",
      denyKind: "capability",
      capabilityId: `mcp.${SERVER}.create_payment`,
      resourceScopeDigest: null,
      targetKind: "tool_version",
      targetId: "tlv_pay",
    });
    const conflict = insert && insert.op === "insert" ? insert.conflict : null;
    expect(conflict?.target).toEqual([
      schema.emergencyDenies.orgId,
      schema.emergencyDenies.workspaceId,
      schema.emergencyDenies.targetKind,
      schema.emergencyDenies.targetId,
    ]);
    expect(conflict ? sqlOf(conflict.where) : null).toBe(
      "active = true AND workspace_id IS NOT NULL",
    );
  });

  it("a switch on another workspace of the organisation is written org-wide, scoped by its digest", async () => {
    const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
    const out = await handlerOver(flip)(
      {
        target: { kind: "workspace", id: OTHER_WS },
        on: true,
        reason: "workspace compromised",
      },
      ctx(),
    );
    expect(out.denyGeneration).toEqual({ org: 2, workspace: 0 });
    const insert = flip.ops.find((o) => o.op === "insert");
    expect(
      insert && insert.op === "insert" ? insert.values : null,
    ).toMatchObject({
      orgId: ORG,
      workspaceId: null,
      scopeKind: "org",
      denyKind: "resource_scope",
      resourceScopeDigest: resourceScopeDigestOf({
        kind: "workspace",
        id: OTHER_WS,
      }),
      targetKind: "workspace",
      targetId: OTHER_WS,
    });
  });

  it("a connection switch revokes the connection's live grants in the same transaction", async () => {
    const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 3 });
    const out = await handlerOver(flip)(
      {
        target: { kind: "connection", id: "mcrd_gh" },
        on: true,
        reason: "leaked",
      },
      ctx(),
    );
    expect(out.grantsRevoked).toBe(3);
    const revoke = flip.ops.find(
      (o) => o.op === "update" && o.table === schema.mcpCredentialGrants,
    );
    expect(revoke).toBeDefined();
    const sql = new PgDialect().sqlToQuery((revoke as { cond: SQL }).cond).sql;
    expect(sql).toContain("connection_id");
    expect(sql).toContain("revoked_at");
  });

  it("flipping on a switch that is already on writes nothing: the insert conflicts and the row that is on is reported", async () => {
    const flip = flipTx({
      generation: 7,
      activeSwitches: [{ id: "id_on", publicId: "emd_on" }],
      liveGrants: 3,
    });
    const out = await handlerOver(flip)(
      {
        target: { kind: "connection", id: "mcrd_gh" },
        on: true,
        reason: "again",
      },
      ctx(),
    );
    expect(out).toMatchObject({
      switchId: "emd_on",
      changed: false,
      denyGeneration: { org: 7, workspace: 0 },
      grantsRevoked: 0,
    });
    expect(flip.ops.some((o) => o.op === "update")).toBe(false);
    // Nothing changed, so no security event.
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it("flips a switch off: deactivates the row, keeps it, and returns the bumped generation", async () => {
    const flip = flipTx({
      generation: 7,
      activeSwitches: [{ id: "id_on", publicId: "emd_on" }],
      liveGrants: 0,
    });
    const out = await handlerOver(flip)(
      {
        target: { kind: "class", id: "moves_money" },
        on: false,
        reason: "resolved",
      },
      ctx(),
    );
    expect(out).toEqual({
      switchId: "emd_on",
      on: false,
      changed: true,
      denyGeneration: { org: 8, workspace: 0 },
      grantsRevoked: 0,
    });
    const update = flip.ops.find(
      (o) => o.op === "update" && o.table === schema.emergencyDenies,
    );
    expect(update && update.op === "update" ? update.set : null).toMatchObject({
      active: false,
      clearedReason: "resolved",
      updatedById: USER,
    });
    expect(flip.ops.some((o) => o.op === "insert")).toBe(false);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledTimes(1);
  });

  it("flipping off deactivates every active row for the target, by target and not by one row's id", async () => {
    const flip = flipTx({
      generation: 7,
      activeSwitches: [
        { id: "id_first", publicId: "emd_first" },
        { id: "id_second", publicId: "emd_second" },
      ],
      liveGrants: 0,
    });
    const out = await handlerOver(flip)(
      {
        target: { kind: "class", id: "moves_money" },
        on: false,
        reason: "resolved",
      },
      ctx(),
    );
    expect(out).toMatchObject({
      switchId: "emd_first",
      on: false,
      changed: true,
      denyGeneration: { org: 9, workspace: 0 },
    });
    expect(flip.state.activeSwitches).toEqual([]);
    const update = flip.ops.find(
      (o) => o.op === "update" && o.table === schema.emergencyDenies,
    );
    const predicate =
      update && update.op === "update" ? sqlOf(update.cond) : "";
    expect(predicate).toContain('"org_id" = ');
    expect(predicate).toContain('"workspace_id" is null');
    expect(predicate).toContain('"target_kind" = ');
    expect(predicate).toContain('"target_id" = ');
    expect(predicate).toContain('"active" = ');
    expect(predicate).not.toContain('"id" = ');
  });

  it("flips off a connection switch whose connection was deleted while it was on, without looking the connection up", async () => {
    const flip = flipTx({
      generation: 7,
      activeSwitches: [{ id: "id_on", publicId: "emd_on" }],
      liveGrants: 3,
    });
    // The credential behind the connection is gone: every lookup finds nothing.
    const gone = {
      ...lookups,
      connection: vi.fn(async () => null),
    };
    const out = await createKillSwitchSetHandler({
      lookups: gone,
      transaction: (fn) => fn(flip.tx as never),
    })(
      {
        target: { kind: "connection", id: "mcrd_gh" },
        on: false,
        reason: "credential revoked",
      },
      ctx(),
    );
    expect(out).toEqual({
      switchId: "emd_on",
      on: false,
      changed: true,
      denyGeneration: { org: 8, workspace: 0 },
      grantsRevoked: 0,
    });
    expect(gone.connection).not.toHaveBeenCalled();
    expect(flip.state.activeSwitches).toEqual([]);
    const update = flip.ops.find(
      (o) => o.op === "update" && o.table === schema.emergencyDenies,
    );
    const q =
      update && update.op === "update"
        ? new PgDialect().sqlToQuery(update.cond)
        : { sql: "", params: [] };
    expect(q.sql).toContain('"workspace_id" = ');
    expect(q.sql).toContain('"target_kind" = ');
    expect(q.sql).toContain('"target_id" = ');
    expect(q.params).toEqual(
      expect.arrayContaining([ORG, WS, "connection", "mcrd_gh"]),
    );
    // An off flip revokes nothing: the grants went with the on flip.
    expect(
      flip.ops.some(
        (o) => o.op === "update" && o.table === schema.mcpCredentialGrants,
      ),
    ).toBe(false);
    expect(mocks.emitSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS }),
    );
  });

  it("flips an operator switch on from a selected member's usr_ public id", async () => {
    const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
    const out = await handlerOver(flip)(
      {
        target: { kind: "operator", id: USER_PUBLIC_ID },
        on: true,
        reason: "compromised laptop",
      },
      ctx(),
    );
    expect(out).toMatchObject({ changed: true, on: true });
    const insert = flip.ops.find((o) => o.op === "insert");
    expect(
      insert && insert.op === "insert" ? insert.values : null,
    ).toMatchObject({
      workspaceId: null,
      scopeKind: "org",
      denyKind: "resource_scope",
      // The digest matches the raw user id the live gate carries as
      // ctx.userId, not the public id the caller submitted (#3147).
      resourceScopeDigest: resourceScopeDigestOf({
        kind: "operator",
        id: USER,
      }),
      targetKind: "operator",
      targetId: USER_PUBLIC_ID,
    });
  });

  it("flips an operator switch on from the raw user uuid, kept for backward compatibility", async () => {
    const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
    const out = await handlerOver(flip)(
      { target: { kind: "operator", id: USER }, on: true, reason: "x" },
      ctx(),
    );
    expect(out).toMatchObject({ changed: true, on: true });
    const insert = flip.ops.find((o) => o.op === "insert");
    expect(
      insert && insert.op === "insert" ? insert.values : null,
    ).toMatchObject({
      resourceScopeDigest: resourceScopeDigestOf({
        kind: "operator",
        id: USER,
      }),
      targetId: USER,
    });
  });

  it("an unknown operator usr_ id is refused by name, not a generic schema failure", async () => {
    const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
    await expect(
      handlerOver(flip)(
        {
          target: { kind: "operator", id: "usr_missing" },
          on: true,
          reason: "x",
        },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "operator_not_found",
    });
    expect(flip.ops).toEqual([]);
  });

  it("an operator outside the org is refused by name, the same not_found an unknown id gets", async () => {
    const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
    // resolveOperator's org join (postgresKillSwitchTargetLookups) answers
    // null for a real user who is simply not a member of this org; the fake
    // here models that the same way it models "does not exist".
    const outOfOrg = {
      ...lookups,
      resolveOperator: vi.fn(async () => null),
    };
    await expect(
      createKillSwitchSetHandler({
        lookups: outOfOrg,
        transaction: (fn) => fn(flip.tx as never),
      })(
        {
          target: { kind: "operator", id: "usr_other_org" },
          on: true,
          reason: "x",
        },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "operator_not_found",
    });
    expect(outOfOrg.resolveOperator).toHaveBeenCalledWith(ORG, "usr_other_org");
  });

  it("turning on a switch for a target that does not exist is not_found and writes nothing", async () => {
    const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
    await expect(
      handlerOver(flip)(
        {
          target: { kind: "connection", id: "mcrd_missing" },
          on: true,
          reason: "x",
        },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "not_found",
      reason: "connection_not_found",
    });
    expect(flip.ops).toEqual([]);
  });

  it("flipping off a switch that is not on is a conflict", async () => {
    const flip = flipTx({ generation: 7, activeSwitches: [], liveGrants: 0 });
    await expect(
      handlerOver(flip)(
        {
          target: { kind: "class", id: "moves_money" },
          on: false,
          reason: "x",
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "conflict", reason: "switch_not_on" });
    expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
  });

  it.each(["Member", "Billing", "Compliance", null])(
    "refuses a tier-free org member holding %s with forbidden and writes nothing",
    async (role) => {
      stubRole(role);
      const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
      const err = await handlerOver(flip)(
        { target: { kind: "class", id: "moves_money" }, on: true, reason: "x" },
        ctx(),
      ).catch((e: unknown) => e);
      expect(isHandlerError(err) && err.code).toBe("forbidden");
      expect(flip.ops).toEqual([]);
      expect(mocks.emitSecurityEvent).not.toHaveBeenCalled();
    },
  );

  it("refuses a request with no signed-in user", async () => {
    const flip = flipTx({ generation: 1, activeSwitches: [], liveGrants: 0 });
    const err = await handlerOver(flip)(
      { target: { kind: "class", id: "moves_money" }, on: true, reason: "x" },
      ctx({ userId: null }),
    ).catch((e: unknown) => e);
    expect(isHandlerError(err) && err.reason).toBe("no_principal");
  });
});

describe("kill-switch transaction scope", () => {
  it.each([
    ["class", "moves_money", null],
    ["workspace", WS, null],
    ["org", ORG, null],
    ["operator", USER_PUBLIC_ID, null],
    ["tool_version", "tlv_pay", WS],
    ["tool_server", "mcs_github", WS],
    ["connection", "mcrd_gh", WS],
    ["agent", "agt_finops", WS],
  ] as const)(
    "routes %s writes to the matching scope",
    async (kind, id, expectedWorkspace) => {
      const flip = flipTx({ generation: 4, activeSwitches: [], liveGrants: 0 });
      const transaction = vi.fn(
        (fn: (tx: never) => Promise<unknown>, _workspaceId: string | null) =>
          fn(flip.tx as never),
      );
      const handler = createKillSwitchSetHandler({
        lookups,
        transaction: transaction as never,
      });
      await handler(
        { target: { kind, id }, on: true, reason: "Scope regression" },
        ctx(),
      );
      expect(transaction.mock.calls[0]?.[1]).toBe(expectedWorkspace);
    },
  );
});

describe("production kill-switch database seam", () => {
  it.each(["class", "tool_version"] as const)(
    "clears %s through the correct database seam",
    async (kind) => {
      const flip = flipTx({
        generation: 4,
        activeSwitches: [{ id: "deny-id", publicId: "emd_active" }],
        liveGrants: 0,
      });
      const roleRead = mocks.withTenantDb.getMockImplementation();
      if (!roleRead) throw new Error("Missing role fixture");
      mocks.withOrgDb
        .mockImplementationOnce(roleRead)
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(flip.tx));
      mocks.withTenantDb.mockReset();
      mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
        fn(flip.tx),
      );
      await killSwitchSetHandler(
        {
          target: { kind, id: kind === "class" ? "moves_money" : "tlv_pay" },
          on: false,
          reason: "Recovered",
        },
        ctx(),
      );
      expect(mocks.withOrgDb).toHaveBeenCalledTimes(kind === "class" ? 2 : 1);
      expect(mocks.withTenantDb).toHaveBeenCalledTimes(
        kind === "class" ? 0 : 1,
      );
    },
  );
});
