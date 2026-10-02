/**
 * Unit tests for the set_assistant_switch handler.
 *
 * The handler has no role gate: reaching it at all is the authorization, and
 * the kernel owns that (INV-31, the contract's test). What is asserted here is
 * the row it writes. The real flipKillSwitchOn and flipKillSwitchOff run
 * against a tx double that models iam.emergency_denies, including the partial
 * unique index over a target's active row, and the real agent lookup runs
 * against a double of the agents table that evaluates the query's predicate.
 * So the tests prove the switch lands on the `agent` deny readAssistantAgentState
 * matches, under the input's workspace, for the qa-chat agent and no other.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { schema } from "@oxagen/database";
import {
  flipKillSwitchOff,
  flipKillSwitchOn,
  resourceScopeDigestOf,
} from "@oxagen/iam";
import { requireScope } from "@oxagen/tenancy";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  emitSecurityEventAsync: vi.fn<(event: unknown) => Promise<void>>(
    async () => {},
  ),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The organisation-wide seam is stubbed with the same function, so no path
  // reaches a real transaction (check:db-mock-seams, ADR-086).
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("@oxagen/database/security", () => ({
  emitSecurityEventAsync: mocks.emitSecurityEventAsync,
}));

import {
  assistantSwitchSetHandler,
  createAssistantSwitchSetHandler,
  findManagedAssistantAgent,
} from "./assistant.switch.set";

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-00000000ac40";
const OTHER_WS = "0192d4a8-7c1e-7a00-8000-00000000ac41";
const REASON = "Incident 2026-10-01: the assistant quotes stale spend";

/** The workspace's managed assistant agent, as workspace bootstrap writes it. */
const QA_CHAT = {
  public_id: "agt_qachat",
  org_id: ORG,
  workspace_id: WS,
  slug: "qa-chat",
  agent_type: "interactive_chat",
  deleted_at: null,
};
/** A customer's own agent in the same workspace. */
const CUSTOM = {
  public_id: "agt_finops",
  org_id: ORG,
  workspace_id: WS,
  slug: "finops-bot",
  agent_type: "custom",
  deleted_at: null,
};

type AgentRow = Record<string, string | null>;

/** What an operator script builds: no tenant, no user, surface "runner". */
const operatorCtx = (): CapabilityContext => ({
  orgId: "",
  workspaceId: "",
  userId: null,
  apiKeyId: null,
  requestId: "req-operator",
  surface: "runner",
  messageId: null,
});

const input = (on: boolean) => ({
  orgId: ORG,
  workspaceId: WS,
  on,
  reason: REASON,
});

const dialect = new PgDialect();

/**
 * The rows a conjunction of `col = $n` and `col IS NULL` terms selects. It is
 * enough for the agent lookup, and it throws on any other term.
 */
function evaluate(cond: SQL, rows: readonly AgentRow[]): AgentRow[] {
  const { sql, params } = dialect.sqlToQuery(cond);
  const terms = sql
    .replace(/^\(|\)$/g, "")
    .split(/ and /i)
    .map((term) => term.trim());
  return rows.filter((row) =>
    terms.every((term) => {
      const eq = /"(\w+)" = \$(\d+)$/.exec(term);
      if (eq) return row[eq[1]!] === params[Number(eq[2]) - 1];
      const isNull = /"(\w+)" is null$/i.exec(term);
      if (isNull) return row[isNull[1]!] === null;
      throw new Error(`unexpected predicate term: ${term}`);
    }),
  );
}

type Write =
  | { op: "insert"; values: Record<string, unknown> }
  | { op: "update"; set: Record<string, unknown> };

/**
 * A tx double over the agents table and iam.emergency_denies. An INSERT while
 * an active row exists conflicts and writes nothing, as the partial unique
 * index does.
 */
function fakeTx(state: {
  agents: AgentRow[];
  active: { publicId: string }[];
}) {
  const writes: Write[] = [];
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: (cond: SQL) => ({
          limit: async () => {
            if (table === schema.agents) {
              return evaluate(cond, state.agents).map((r) => ({
                publicId: r.public_id,
              }));
            }
            if (table === schema.emergencyDenies) return state.active;
            throw new Error("unexpected table");
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (table !== schema.emergencyDenies)
              throw new Error("unexpected table");
            if (state.active.length > 0) return [];
            writes.push({ op: "insert", values });
            state.active = [{ publicId: "emd_new" }];
            return [{ publicId: "emd_new" }];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (table !== schema.emergencyDenies)
              throw new Error("unexpected table");
            const hit = state.active;
            if (hit.length > 0) writes.push({ op: "update", set });
            state.active = [];
            return hit;
          },
        }),
      }),
    }),
  };
  return { tx, writes, state };
}

function handlerOver(double: ReturnType<typeof fakeTx>) {
  const scopes: { orgId: string; workspaceId: string }[] = [];
  const handler = createAssistantSwitchSetHandler({
    transaction: (scope, fn) => {
      scopes.push(scope);
      return fn(double.tx as never);
    },
    findAssistantAgent: findManagedAssistantAgent,
    flipOn: flipKillSwitchOn,
    flipOff: flipKillSwitchOff,
  });
  return { handler, scopes };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emitSecurityEventAsync.mockResolvedValue(undefined);
});

describe("set_assistant_switch handler", () => {
  it("turning it on writes an agent deny for the qa-chat agent under the input workspace", async () => {
    const double = fakeTx({ agents: [CUSTOM, QA_CHAT], active: [] });
    const { handler, scopes } = handlerOver(double);

    const out = await handler(input(true), operatorCtx());

    expect(out).toEqual({ switchId: "emd_new", changed: true });
    expect(scopes).toEqual([{ orgId: ORG, workspaceId: WS }]);
    expect(double.writes).toHaveLength(1);
    expect(double.writes[0]).toEqual({
      op: "insert",
      values: expect.objectContaining({
        orgId: ORG,
        workspaceId: WS,
        scopeKind: "workspace",
        denyKind: "resource_scope",
        capabilityId: null,
        // The digest readAssistantAgentState matches for this agent.
        resourceScopeDigest: resourceScopeDigestOf({
          kind: "agent",
          id: "agt_qachat",
        }),
        principalId: null,
        targetKind: "agent",
        targetId: "agt_qachat",
        reason: REASON,
        active: true,
        // A platform operator acts with no user.
        flippedByUserId: null,
        createdById: null,
        updatedById: null,
      }),
    });
  });

  it("turning it on when it is already on writes nothing and reports the row that is on", async () => {
    const double = fakeTx({
      agents: [QA_CHAT],
      active: [{ publicId: "emd_on" }],
    });
    const { handler } = handlerOver(double);

    const out = await handler(input(true), operatorCtx());

    expect(out).toEqual({ switchId: "emd_on", changed: false });
    expect(double.writes).toEqual([]);
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  it("turning it off clears the row and records why, with no user", async () => {
    const double = fakeTx({
      agents: [QA_CHAT],
      active: [{ publicId: "emd_on" }],
    });
    const { handler } = handlerOver(double);

    const out = await handler(input(false), operatorCtx());

    expect(out).toEqual({ switchId: "emd_on", changed: true });
    expect(double.writes).toEqual([
      {
        op: "update",
        set: expect.objectContaining({
          active: false,
          clearedReason: REASON,
          updatedById: null,
        }),
      },
    ]);
    expect(double.state.active).toEqual([]);
  });

  it("turning it off when none is on returns no switch and no error", async () => {
    const double = fakeTx({ agents: [QA_CHAT], active: [] });
    const { handler } = handlerOver(double);

    const out = await handler(input(false), operatorCtx());

    expect(out).toEqual({ switchId: null, changed: false });
    expect(double.writes).toEqual([]);
    expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
  });

  const notFoundCases: [string, AgentRow[]][] = [
    ["has no agents", []],
    ["holds only a customer's agent", [CUSTOM]],
    [
      "holds a qa-chat agent that is not the managed type",
      [{ ...QA_CHAT, agent_type: "custom" }],
    ],
    [
      "holds a deleted qa-chat agent",
      [{ ...QA_CHAT, deleted_at: "2026-09-30T00:00:00.000Z" }],
    ],
    [
      "has its qa-chat agent in another workspace only",
      [{ ...QA_CHAT, workspace_id: OTHER_WS }],
    ],
  ];

  it.each(notFoundCases)(
    "is not_found and writes nothing when the workspace %s",
    async (_case, agents) => {
      for (const on of [true, false]) {
        const double = fakeTx({
          agents: [...agents],
          active: [{ publicId: "emd_on" }],
        });
        const { handler } = handlerOver(double);

        const err = await handler(input(on), operatorCtx()).catch(
          (e: unknown) => e,
        );

        expect(isHandlerError(err) && err.code).toBe("not_found");
        expect(double.writes).toEqual([]);
        expect(double.state.active).toEqual([{ publicId: "emd_on" }]);
      }
      expect(mocks.emitSecurityEventAsync).not.toHaveBeenCalled();
    },
  );

  it("never names a customer's agent in the switch it writes", async () => {
    const double = fakeTx({ agents: [CUSTOM, QA_CHAT], active: [] });
    const { handler } = handlerOver(double);

    await handler(input(true), operatorCtx());

    const values = double.writes.map((w) =>
      w.op === "insert" ? w.values : w.set,
    );
    expect(JSON.stringify(values)).not.toContain("agt_finops");
    expect(values[0]?.resourceScopeDigest).not.toBe(
      resourceScopeDigestOf({ kind: "agent", id: "agt_finops" }),
    );
  });

  it("audits a change as tool.kill_switch_flipped against the workspace, with no acting user", async () => {
    const double = fakeTx({ agents: [QA_CHAT], active: [] });
    const { handler } = handlerOver(double);

    await handler(input(true), operatorCtx());

    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledOnce();
    expect(mocks.emitSecurityEventAsync).toHaveBeenCalledWith({
      eventType: "tool.kill_switch_flipped",
      actorUserId: null,
      orgId: ORG,
      workspaceId: WS,
      capability: "set_assistant_switch",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: "req-operator",
    });
  });

  it("does not resolve until the audit row is written", async () => {
    let releaseAudit: () => void = () => {};
    mocks.emitSecurityEventAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseAudit = resolve;
      }),
    );
    const double = fakeTx({ agents: [QA_CHAT], active: [] });
    const { handler } = handlerOver(double);

    let resolved = false;
    const run = handler(input(true), operatorCtx()).then(() => {
      resolved = true;
    });
    await vi.waitFor(() =>
      expect(mocks.emitSecurityEventAsync).toHaveBeenCalledOnce(),
    );

    expect(double.writes).toHaveLength(1);
    expect(resolved).toBe(false);

    releaseAudit();
    await run;
    expect(resolved).toBe(true);
  });

  it("fails when the audit row cannot be written, after the switch is on", async () => {
    mocks.emitSecurityEventAsync.mockRejectedValue(
      new Error("security_events insert failed after 3 attempts"),
    );
    const double = fakeTx({ agents: [QA_CHAT], active: [] });
    const { handler } = handlerOver(double);

    await expect(handler(input(true), operatorCtx())).rejects.toThrow(
      /security_events insert failed/,
    );
    expect(double.state.active).toEqual([{ publicId: "emd_new" }]);
  });
});

describe("assistantSwitchSetHandler wiring", () => {
  it("looks up the agent and writes the switch inside the input workspace's tenant scope", async () => {
    const double = fakeTx({ agents: [QA_CHAT], active: [] });
    const seen: { orgId: string; workspaceId: string }[] = [];
    mocks.withTenantDb.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const scope = requireScope();
        seen.push({ orgId: scope.orgId, workspaceId: scope.workspaceId });
        return fn(double.tx);
      },
    );

    const out = await assistantSwitchSetHandler(input(true), operatorCtx());

    expect(out).toEqual({ switchId: "emd_new", changed: true });
    // One transaction, scoped to the input's tenant, not the context's empty one.
    expect(seen).toEqual([{ orgId: ORG, workspaceId: WS }]);
    expect(double.writes[0]).toEqual({
      op: "insert",
      values: expect.objectContaining({
        targetKind: "agent",
        targetId: "agt_qachat",
        workspaceId: WS,
      }),
    });
  });
});
