/**
 * Can an in-app assistant turn answer the approval its own write parked?
 * ADR-XXX records the answer and the change that made it no.
 *
 * The turn is assembled the way `runPreparedTurn` (runtime/assistant-turn.ts)
 * assembles it: the person's context carrying the turn's message id, the belt
 * materialized under `approvalMode: "park"` before the run exists, and the
 * run's id handed to every tool through `runIdRef` once the run opens. The
 * kernel, the contracts, `materializeTools`, `createApprovalRequest` and the
 * resolve_approval handler are real. The stores are doubles: one approval row,
 * the run it names, and the rows the role gate reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { getTableColumns, type SQL } from "drizzle-orm";
import { schema } from "@oxagen/database";
import { isHandlerError } from "@oxagen/oxagen";
import {
  clearBillingAdmissionGate,
  clearHandlersForTests,
  clearKernelIAMRuntime,
  clearSecurityEventEmitter,
  invoke,
  registerHandler,
  setKernelIAMRuntime,
} from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "../types";

const db = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  recordConsent: vi.fn(async () => ({ consentId: "mcons_1" })),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: db.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// Telemetry goes to ClickHouse, and the belt isolates its failures. The
// approval fan-out tells approvers, which is not what this file asks about.
vi.mock("@oxagen/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/telemetry")>()),
  insertToolInvocation: vi.fn(async () => undefined),
}));
vi.mock("@oxagen/rules/approval-notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/rules/approval-notify")>()),
  notifyApprovalRequested: vi.fn(async () => undefined),
}));
vi.mock("@oxagen/plugins", () => ({
  listEntitledCapabilityPluginIds: vi.fn(async () => new Set<string>()),
}));
// A workspace with no MCP servers: the belt holds the capability tools only.
vi.mock("../runtime/plugin-type", () => ({
  registerPluginType: () => undefined,
  getPluginTypeContributors: () => [],
}));
// The durable consent row lives in agent.mcp_consents, which the double does
// not model. What the resolver records there is asserted on the spy.
vi.mock("../runtime/consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime/consent")>()),
  recordConsent: db.recordConsent,
}));

import { agentApprovalResolveHandler } from "./agent.approval.resolve";
import { agentMcpConsentResolveHandler } from "./agent.mcp_consent.resolve";
import {
  ApprovalPendingError,
  materializeTools,
} from "../runtime/materialize-tools";

const ORG_ID = "0192d4a8-0000-7000-8000-000000000001";
const WORKSPACE_ID = "0192d4a8-0000-7000-8000-000000000002";
const USER_ID = "0192d4a8-0000-7000-8000-000000000003";
const PRINCIPAL_ID = "0192d4a8-0000-7000-8000-000000000004";
const MESSAGE_ID = "0192d4a8-0000-7000-8000-000000000005";
const CONVERSATION_ID = "0192d4a8-0000-7000-8000-000000000006";
const RUN_ID = "0192d4a8-0000-7000-8000-000000000007";
const RUN_PUBLIC_ID = "arun_01k5rt9xq7v3m8n2p4s6t8w0";
const ROW_ID = "0192d4a8-0000-7000-8000-000000000008";
const APPROVAL_PUBLIC_ID = "apr_01k5rt9xq7v3m8n2p4s6t8w1";
const KEY_PUBLIC_ID = "aky_01k5rt9xq7v3m8n2p4s6t8w2";
/** A high-risk write the contract parks for a person (`requiresApproval`). */
const WRITE = "revoke_api_key";
const RESOLVE = "resolve_approval";
const CONSENT = "resolve_mcp_consent";
const SERVER_ID = "0192d4a8-0000-7000-8000-000000000009";
const CONSENT_ROW_ID = "0192d4a8-0000-7000-8000-00000000000a";

/** The person's context for the turn, as `runPreparedTurn` builds it. */
const TURN_CTX: CapabilityContext = {
  orgId: ORG_ID,
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  apiKeyId: null,
  requestId: "req_turn",
  surface: "app",
  messageId: MESSAGE_ID,
  executionStepId: MESSAGE_ID,
};

// ── the stores ───────────────────────────────────────────────────────────────

const dialect = new PgDialect();
const params = (q: SQL | null) => (q ? dialect.sqlToQuery(q).params : []);

type Row = Record<string, unknown>;
const store: { row: Row | null } = { row: null };

/** The row's values for a projection `{ alias: column }`, read by column. */
function project(table: unknown, row: Row, fields: Row): Row {
  const columns = getTableColumns(table as never) as Row;
  return Object.fromEntries(
    Object.entries(fields).map(([alias, column]) => {
      const key = Object.keys(columns).find((k) => columns[k] === column);
      return [alias, key === undefined ? undefined : row[key]];
    }),
  );
}

const pending = (): Row | null => {
  const row = store.row;
  if (!row || row.resolution !== null) return null;
  return (row.expiresAt as Date).getTime() > Date.now() ? row : null;
};

function rowsFor(table: unknown, fields: Row, where: SQL | null): Row[] {
  if (table === schema.approvalRequests) {
    const row = pending();
    return row ? [project(table, row, fields)] : [];
  }
  if (table === schema.agentRuns) {
    return params(where).includes(RUN_ID) ? [{ publicId: RUN_PUBLIC_ID }] : [];
  }
  if (table === schema.principals) return [{ id: PRINCIPAL_ID }];
  if (table === schema.principalRoleAssignments) {
    // An org Owner. An assignment that pins the workspace holds nothing.
    return params(where).includes(WORKSPACE_ID) ? [] : [{ roleName: "Owner" }];
  }
  // The requester lookup: the person who wrote the turn's message.
  if (table === schema.messages) return [{ userId: USER_ID }];
  throw new Error("unexpected table");
}

function makeTx() {
  const tx = {
    query: {
      messages: {
        findFirst: async () => ({
          id: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
        }),
      },
      conversations: {
        findFirst: async () => ({ id: CONVERSATION_ID, userId: USER_ID }),
      },
      // No live approval holds this call's resume key yet.
      approvalRequests: { findFirst: async () => undefined },
    },
    // The advisory lock around the park, and the resolution's pg_notify.
    execute: async () => undefined,
    select: (fields: Row) => ({
      from: (table: unknown) => {
        let where: SQL | null = null;
        const chain = {
          innerJoin: () => chain,
          where: (cond: SQL) => {
            where = cond;
            return chain;
          },
          limit: async () => rowsFor(table, fields, where),
        };
        return chain;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Row) => ({
        returning: async (fields: Row) => {
          if (table !== schema.approvalRequests)
            throw new Error("unexpected table");
          store.row = {
            // The column default: a writer that names no kind asks for an
            // approval.
            kind: "approval",
            ...values,
            id: ROW_ID,
            publicId: APPROVAL_PUBLIC_ID,
            resolution: null,
            resolvedAt: null,
            resolvedByUserId: null,
            note: null,
          };
          return [project(table, store.row, fields)];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => ({
          returning: async (fields: Row) => {
            if (table !== schema.approvalRequests)
              throw new Error("unexpected table");
            const row = pending();
            if (!row) return [];
            // The handler's resume_status CASE, evaluated for this one row.
            const queues =
              "resumeStatus" in values && row.resumePayload != null;
            Object.assign(row, values, {
              resumeStatus: queues
                ? values.resolution === "approved"
                  ? "queued"
                  : "denied"
                : row.resumeStatus,
            });
            return [project(table, row, fields)];
          },
        }),
      }),
    }),
  };
  return tx;
}

// ── the turn ─────────────────────────────────────────────────────────────────

/**
 * The belt a turn hands the engine, with the run opened after the belt
 * exists, exactly as `runPreparedTurn` orders it. `call` runs one tool the
 * way the engine does: by its model-facing alias, with a tool-call id.
 */
async function openTurn() {
  const runIdRef: { current: string | null } = { current: null };
  const { tools, nameMap } = await materializeTools(TURN_CTX, {
    runIdRef,
    excludeCapabilities: new Set(["search_tools", "load_tools"]),
    approvalMode: "park",
    killSwitchGate: { check: async () => null },
  });
  runIdRef.current = RUN_ID;
  const call = (capability: string, input: unknown, toolCallId: string) => {
    const alias = Object.keys(nameMap).find((a) => nameMap[a] === capability);
    if (alias === undefined)
      throw new Error(`${capability} is not on the belt`);
    const t = tools[alias] as unknown as {
      execute: (input: unknown, options: unknown) => Promise<unknown>;
    };
    return t.execute(input, { toolCallId, messages: [] });
  };
  return { capabilities: Object.values(nameMap), call };
}

/** Parks the write and returns the approval id the model is told. */
async function parkWrite(turn: Awaited<ReturnType<typeof openTurn>>) {
  const parked = turn.call(WRITE, { keyPublicId: KEY_PUBLIC_ID }, "call_park");
  const err = await parked.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApprovalPendingError);
  // The refusal the engine hands back to the model names the approval.
  const approvalId = /waiting for approval (\S+) until/.exec(
    (err as Error).message,
  )?.[1];
  expect(approvalId).toBe(ROW_ID);
  return approvalId!;
}

beforeEach(() => {
  vi.stubEnv(
    "AUTH_TOKEN_ENCRYPTION_KEY",
    Buffer.alloc(32, 7).toString("base64"),
  );
  store.row = null;
  db.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(makeTx())),
  );
  clearHandlersForTests();
  clearBillingAdmissionGate();
  clearSecurityEventEmitter();
  // An enterprise org's IAM resolver names the person, not an agent: the
  // assistant acts as whoever typed the message.
  setKernelIAMRuntime(
    async () => ({
      outcome: "allow",
      principal: {
        id: PRINCIPAL_ID,
        kind: "human",
        orgId: ORG_ID,
        workspaceId: null,
      },
    }),
    true,
  );
  registerHandler(
    RESOLVE,
    async () => (input, ctx) =>
      agentApprovalResolveHandler(
        input as Parameters<typeof agentApprovalResolveHandler>[0],
        ctx,
      ),
  );
  registerHandler(
    CONSENT,
    async () => (input, ctx) =>
      agentMcpConsentResolveHandler(
        input as Parameters<typeof agentMcpConsentResolveHandler>[0],
        ctx,
      ),
  );
  registerHandler(WRITE, async () => async () => {
    throw new Error("a parked write must not run");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearKernelIAMRuntime();
  clearHandlersForTests();
});

describe("resolve_approval: a turn answering its own parked write", () => {
  // Before ADR-XXX this belt carried resolve_approval, and a call from it
  // resolved: the model approved the key revocation its own turn had parked,
  // as the person, with the id the refusal had just told it.

  it("parks the write on the row with the turn's run and message", async () => {
    const turn = await openTurn();
    await parkWrite(turn);
    expect(store.row).toMatchObject({
      capabilityName: WRITE,
      messageId: MESSAGE_ID,
      runPublicId: RUN_PUBLIC_ID,
      resolution: null,
    });
  });

  it("gives the turn's model no resolve_approval tool, and the kernel refuses it the agent surface", async () => {
    const turn = await openTurn();
    const approvalId = await parkWrite(turn);
    expect(turn.capabilities).toContain(WRITE);
    expect(turn.capabilities).not.toContain(RESOLVE);
    // The context and options the belt's execute hands the kernel.
    await expect(
      invoke(
        RESOLVE,
        { approvalId, decision: "approved" },
        { ...TURN_CTX, toolCallId: "call_self" },
        { surface: "agent", runId: RUN_ID },
      ),
    ).rejects.toMatchObject({ code: "surface_denied" });
    expect(store.row?.resolution).toBeNull();
  });

  it("refuses a call that carries the run that raised the approval, on a surface that still lists it", async () => {
    const turn = await openTurn();
    const approvalId = await parkWrite(turn);
    const err = await invoke(
      RESOLVE,
      { approvalId, decision: "approved" },
      { ...TURN_CTX, toolCallId: "call_self" },
      { runId: RUN_ID },
    ).catch((e: unknown) => e);
    expect(
      isHandlerError(err) &&
        err.code === "forbidden" &&
        err.reason === "run_cannot_resolve_own_approval",
    ).toBe(true);
    expect((err as Error).message).toMatch(/on Fleet\.$/);
    expect(store.row).toMatchObject({
      resolution: null,
      resolvedByUserId: null,
    });
  });

  it("lets the person resolve the same approval from Fleet after the run was refused", async () => {
    const turn = await openTurn();
    const approvalId = await parkWrite(turn);
    await expect(
      invoke(
        RESOLVE,
        { approvalId, decision: "approved" },
        { ...TURN_CTX, toolCallId: "call_self" },
        { runId: RUN_ID },
      ),
    ).rejects.toSatisfy(isHandlerError);
    // The app's kernel seam: the person's context, no message, no run, and
    // no surface named (apps/app/src/server/kernel.ts).
    const fleet: CapabilityContext = {
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      apiKeyId: null,
      requestId: "req_fleet",
      surface: "app",
      messageId: null,
    };
    await expect(
      invoke(
        RESOLVE,
        { approvalId: APPROVAL_PUBLIC_ID, decision: "approved" },
        fleet,
      ),
    ).resolves.toEqual({
      approvalId: APPROVAL_PUBLIC_ID,
      resolution: "approved",
      mandate: null,
    });
    expect(store.row).toMatchObject({
      resolution: "approved",
      resolvedByUserId: USER_ID,
      resumeStatus: "queued",
    });
  });
});

describe("resolve_mcp_consent: a turn answering a question its run put to a person", () => {
  // Before ADR-XXX the belt carried resolve_mcp_consent too, and its handler
  // answered any pending row by uuid. A call from the turn resolved the
  // approval the turn's write had parked, as the person.

  /** A consent request the gate wrote for this run, as the store holds it. */
  function seedConsentRequest() {
    store.row = {
      id: CONSENT_ROW_ID,
      publicId: "apr_01k5rt9xq7v3m8n2p4s6t8w3",
      kind: "consent",
      capabilityName: `mcp.${SERVER_ID}.search`,
      messageId: MESSAGE_ID,
      runPublicId: RUN_PUBLIC_ID,
      riskLevel: "medium",
      inputDigest: null,
      resumePayload: null,
      resumeStatus: null,
      expiresAt: new Date(Date.now() + 5 * 60_000),
      resolution: null,
      resolvedAt: null,
      resolvedByUserId: null,
      note: null,
    };
  }

  const person: CapabilityContext = {
    orgId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    apiKeyId: null,
    requestId: "req_person",
    surface: "app",
    messageId: null,
  };

  const refusedWith = (code: string, reason: string) => (e: unknown) =>
    isHandlerError(e) && e.code === code && e.reason === reason;

  it("gives the turn's model no resolve_mcp_consent tool, and the kernel refuses it the agent surface", async () => {
    const turn = await openTurn();
    expect(turn.capabilities).not.toContain(CONSENT);
    seedConsentRequest();
    await expect(
      invoke(
        CONSENT,
        { approvalId: CONSENT_ROW_ID, decision: "granted" },
        { ...TURN_CTX, toolCallId: "call_consent" },
        { surface: "agent", runId: RUN_ID },
      ),
    ).rejects.toMatchObject({ code: "surface_denied" });
    expect(store.row?.resolution).toBeNull();
  });

  it("refuses a call that carries the run that raised the consent request", async () => {
    seedConsentRequest();
    await expect(
      invoke(
        CONSENT,
        { approvalId: CONSENT_ROW_ID, decision: "granted" },
        { ...TURN_CTX, toolCallId: "call_consent" },
        { runId: RUN_ID },
      ),
    ).rejects.toSatisfy(
      refusedWith("forbidden", "run_cannot_resolve_own_approval"),
    );
    expect(store.row?.resolution).toBeNull();
    expect(db.recordConsent).not.toHaveBeenCalled();
  });

  it("refuses the approval the turn's write parked: it is not a consent request", async () => {
    const turn = await openTurn();
    const approvalId = await parkWrite(turn);
    await expect(
      invoke(
        CONSENT,
        { approvalId, decision: "granted" },
        { ...TURN_CTX, toolCallId: "call_consent" },
        { runId: RUN_ID },
      ),
    ).rejects.toSatisfy(refusedWith("conflict", "not_a_consent_request"));
    // The probe that found this left the row approved by the person.
    expect(store.row).toMatchObject({
      resolution: null,
      resolvedByUserId: null,
      resumeStatus: "waiting",
    });
  });

  it("lets the person grant a real consent request", async () => {
    seedConsentRequest();
    await expect(
      invoke(
        CONSENT,
        { approvalId: CONSENT_ROW_ID, decision: "granted" },
        person,
      ),
    ).resolves.toEqual({ approvalId: CONSENT_ROW_ID, resolution: "granted" });
    expect(store.row).toMatchObject({
      resolution: "approved",
      resolvedByUserId: USER_ID,
    });
    expect(db.recordConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        serverId: SERVER_ID,
        toolName: "search",
        status: "granted",
      }),
    );
  });
});
