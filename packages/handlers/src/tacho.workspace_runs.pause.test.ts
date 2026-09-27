// pause_workspace_runs (#3862): the role gate, which live runs take the pause
// and which are skipped with their reason, supersession, and the one audit
// event per decision, against an in-memory CommandStore and audit sink. The
// role queries run against a faked tenant transaction, the same fake
// tacho.command.dispatch.test.ts uses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { pauseWorkspaceRuns } from "@oxagen/oxagen/contracts/tacho.workspace_runs.pause";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import type {
  CommandRowInput,
  CommandStore,
  RecipientSession,
} from "./tacho.command.dispatch";
import {
  type AuditEvent,
  createPauseWorkspaceRunsHandler,
  PAUSE_EXPIRES_MS,
} from "./tacho.workspace_runs.pause";

const ORG = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-25T10:00:00.000Z");
const OPERATOR_ID = "00000000-0000-4000-8000-0000000000aa";
const KEY_CREATOR = "00000000-0000-4000-8000-0000000000c7";

const OPERATOR: CapabilityContext = {
  orgId: ORG,
  workspaceId: WORKSPACE,
  userId: OPERATOR_ID,
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
  clientIp: "203.0.113.9",
};

const KEY_CALL: CapabilityContext = {
  ...OPERATOR,
  userId: null,
  apiKeyId: "00000000-0000-4000-8000-0000000000a9",
  surface: "mcp",
  clientIp: null,
};

const dialect = new PgDialect();

/**
 * Answer the role queries: the API key's creator, then an org-wide role
 * (`workspace_id is null`) or a role on the workspace the WHERE pins.
 */
function tenant(
  orgRole: string | null,
  workspaceRole: string | null = null,
  keyCreator: string | null = KEY_CREATOR,
) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            let lastWhere: SQL | null = null;
            const chain = {
              innerJoin: () => chain,
              where: (cond: SQL) => {
                lastWhere = cond;
                return chain;
              },
              limit: () => {
                if (table === schema.apiKeys)
                  return Promise.resolve(
                    keyCreator ? [{ createdById: keyCreator }] : [],
                  );
                if (table === schema.principals)
                  return Promise.resolve([{ id: "prn_1" }]);
                const pinsWorkspace = lastWhere
                  ? /"workspace_id" = \$/.test(
                      dialect.sqlToQuery(lastWhere).sql,
                    )
                  : false;
                const name = pinsWorkspace ? workspaceRole : orgRole;
                return Promise.resolve(name ? [{ roleName: name }] : []);
              },
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

const LIVE_HOST = {
  status: "active",
  lastSeenAt: new Date(NOW.getTime() - 30_000),
  bundleFeatures: [],
};

let seq = 0;
function session(over: Partial<RecipientSession> = {}): RecipientSession {
  seq += 1;
  const n = String(seq).padStart(2, "0");
  return {
    id: `s${n}`,
    publicId: `tse_00000000000000000000${n}`,
    sessionUuid: `3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a${n}`,
    hostId: "11111111-1111-4111-8111-111111111111",
    agentKey: "acme.core.cc-laptop",
    runtime: "claude-code",
    outcome: "running",
    enforcementTier: "harness",
    host: LIVE_HOST,
    ...over,
  };
}

type Row = CommandRowInput & { publicId: string };

class MemoryStore implements CommandStore {
  rows: Row[] = [];
  cancelled: Array<{ publicId: string; detail: string }> = [];
  liveReads: Array<{ scope: unknown; agentKey: string | null }> = [];
  private n = 0;
  constructor(readonly sessions: RecipientSession[]) {}
  async session() {
    return null;
  }
  async liveSessions(scope: unknown, agentKey: string | null) {
    this.liveReads.push({ scope, agentKey });
    return this.sessions.filter((s) => s.outcome === "running");
  }
  async ledgerRunExists() {
    return false;
  }
  async setLedgerPaused(): Promise<string> {
    throw new Error("a workspace pause never touches a ledger run");
  }
  async cancelLedgerRun(): Promise<string> {
    throw new Error("a workspace pause never cancels a ledger run");
  }
  async queueForNextRun(): Promise<string | null> {
    throw new Error("a workspace pause holds nothing for an agent's next run");
  }
  async insert(row: CommandRowInput) {
    const publicId = `tcm_${++this.n}`;
    this.rows.push({ ...row, publicId });
    return { publicId };
  }
  async supersede(args: {
    runPublicId: string;
    command: string;
    successorPublicId: string;
  }) {
    let count = 0;
    for (const row of this.rows) {
      if (
        row.session.publicId === args.runPublicId &&
        row.command === args.command &&
        row.outcome === "queued" &&
        row.publicId !== args.successorPublicId
      ) {
        row.outcome = "cancelled" as Row["outcome"];
        this.cancelled.push({
          publicId: row.publicId,
          detail: `superseded_by:${args.successorPublicId}`,
        });
        count += 1;
      }
    }
    return count;
  }
}

function harness(store: MemoryStore) {
  const events: AuditEvent[] = [];
  const handler = createPauseWorkspaceRunsHandler({
    withStore: (fn) =>
      fn(store, async (event) => {
        events.push(event);
      }),
    now: () => NOW,
  });
  return { handler, events };
}

const input = (reason = "Incident 42: stop and wait") =>
  pauseWorkspaceRuns.input.parse({ reason });
const refused = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "forbidden" && e.reason === reason;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  tenant("Admin");
});

describe("pause_workspace_runs: the role gate", () => {
  it.each([
    ["org Owner", "Owner", null],
    ["org Admin", "Admin", null],
    ["workspace Owner", null, "Owner"],
  ])("admits an %s", async (_label, orgRole, workspaceRole) => {
    tenant(orgRole, workspaceRole);
    const store = new MemoryStore([session()]);
    const { handler, events } = harness(store);
    const out = await handler(input(), OPERATOR);
    expect(out.queued).toBe(1);
    expect(events).toHaveLength(1);
  });

  it.each([
    ["a workspace Member", null, "Member"],
    ["an org Member with no workspace role", "Member", null],
    ["a person with no role at all", null, null],
  ])(
    "refuses %s, and writes no row and no event (negative)",
    async (_label, orgRole, workspaceRole) => {
      tenant(orgRole, workspaceRole);
      const store = new MemoryStore([session()]);
      const { handler, events } = harness(store);
      await expect(handler(input(), OPERATOR)).rejects.toSatisfy(
        refused("org_role_required"),
      );
      expect(store.rows).toEqual([]);
      expect(events).toEqual([]);
    },
  );

  it("refuses a call with no principal (negative)", async () => {
    const store = new MemoryStore([session()]);
    const { handler, events } = harness(store);
    await expect(
      handler(input(), { ...OPERATOR, userId: null, apiKeyId: null }),
    ).rejects.toSatisfy(refused("no_principal"));
    expect(store.rows).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses an API key with no recorded creator (negative)", async () => {
    tenant("Owner", null, null);
    const store = new MemoryStore([session()]);
    const { handler } = harness(store);
    await expect(handler(input(), KEY_CALL)).rejects.toSatisfy(
      refused("no_principal"),
    );
    expect(store.rows).toEqual([]);
  });

  it("acts as the API key's creator on every row and on the audit event", async () => {
    tenant("Owner");
    const store = new MemoryStore([session()]);
    const { handler, events } = harness(store);
    await handler(input(), KEY_CALL);
    expect(store.rows[0]?.issuedByUserId).toBe(KEY_CREATOR);
    expect(events[0]?.actorUserId).toBe(KEY_CREATOR);
    expect(events[0]?.ip).toBeNull();
  });
});

describe("pause_workspace_runs: which runs take the pause", () => {
  const fleet = () => {
    seq = 0;
    return {
      harnessRun: session(),
      observeRun: session({ enforcementTier: "observe" }),
      noHost: session({ hostId: null, host: null }),
      revoked: session({ host: { ...LIVE_HOST, status: "revoked" } }),
      offline: session({
        host: { ...LIVE_HOST, lastSeenAt: new Date(NOW.getTime() - 600_000) },
      }),
      sealed: session({ outcome: "completed" }),
      idleClosed: session({ outcome: "abandoned", sealSource: "idle_timeout" }),
    };
  };

  it("queues one pause per reachable live run, observe tier included (ADR-163), and skips the unreachable with their reason", async () => {
    const f = fleet();
    const store = new MemoryStore(Object.values(f));
    const { handler } = harness(store);
    const out = await handler(input("Incident 42"), OPERATOR);

    expect(store.liveReads).toEqual([
      { scope: { orgId: ORG, workspaceId: WORKSPACE }, agentKey: null },
    ]);
    // The sealed and the idle-closed sessions are not live, so no row.
    expect(store.rows.map((r) => [r.session.publicId, r.outcome])).toEqual([
      [f.harnessRun.publicId, "queued"],
      [f.observeRun.publicId, "queued"],
      [f.noHost.publicId, "failed"],
      [f.revoked.publicId, "failed"],
      [f.offline.publicId, "failed"],
    ]);
    expect(out).toEqual({
      queued: 2,
      commandIds: ["tcm_1", "tcm_2"],
      skipped: [
        {
          runId: f.noHost.publicId,
          agentKey: f.noHost.agentKey,
          reason: "no_host",
          commandId: "tcm_3",
        },
        {
          runId: f.revoked.publicId,
          agentKey: f.revoked.agentKey,
          reason: "host_revoked",
          commandId: "tcm_4",
        },
        {
          runId: f.offline.publicId,
          agentKey: f.offline.agentKey,
          reason: "host_offline",
          commandId: "tcm_5",
        },
      ],
    });
    expect(pauseWorkspaceRuns.output.parse(out)).toEqual(out);
  });

  it("writes each row as a workspace-addressed pause with the reason, the issuer and a one-hour expiry", async () => {
    const f = fleet();
    const store = new MemoryStore([f.harnessRun, f.noHost]);
    const { handler } = harness(store);
    await handler(input("Incident 42"), OPERATOR);
    const expiresAt = new Date(NOW.getTime() + PAUSE_EXPIRES_MS);
    expect(store.rows[0]).toMatchObject({
      scope: { orgId: ORG, workspaceId: WORKSPACE },
      command: "pause",
      payload: { address: "@agents", session_uuid: f.harnessRun.sessionUuid },
      requestedMode: null,
      deliveryMode: null,
      degradedReason: null,
      reason: "Incident 42",
      outcome: "queued",
      outcomeDetail: null,
      issuedByUserId: OPERATOR_ID,
      issuedAt: NOW,
      expiresAt,
    });
    expect(store.rows[1]).toMatchObject({
      command: "pause",
      reason: "Incident 42",
      outcome: "failed",
      outcomeDetail: "no_host",
      expiresAt,
    });
  });

  it("supersedes an earlier queued pause on the same run, and a failed row supersedes nothing", async () => {
    const f = fleet();
    const store = new MemoryStore([f.harnessRun, f.offline]);
    const { handler } = harness(store);
    await handler(input("first"), OPERATOR);
    await handler(input("second"), OPERATOR);
    // tcm_1 queued the first pause on the harness run, and tcm_3 replaced it.
    expect(store.cancelled).toEqual([
      { publicId: "tcm_1", detail: "superseded_by:tcm_3" },
    ]);
  });

  it("answers an empty workspace with an empty receipt and still records the decision", async () => {
    const store = new MemoryStore([]);
    const { handler, events } = harness(store);
    const out = await handler(input(), OPERATOR);
    expect(out).toEqual({ queued: 0, commandIds: [], skipped: [] });
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({
      reason: "Incident 42: stop and wait",
      queued: 0,
      commandIds: [],
      skipped: [],
    });
  });
});

describe("pause_workspace_runs: the audit event", () => {
  it("records exactly one tacho.workspace_runs_paused event per decision, with the counts", async () => {
    seq = 0;
    const live = session();
    const offline = session({
      host: { ...LIVE_HOST, lastSeenAt: new Date(NOW.getTime() - 600_000) },
    });
    const store = new MemoryStore([live, offline]);
    const { handler, events } = harness(store);
    await handler(input("Incident 42"), OPERATOR);
    expect(events).toEqual([
      {
        eventType: "tacho.workspace_runs_paused",
        actorUserId: OPERATOR_ID,
        orgId: ORG,
        workspaceId: WORKSPACE,
        capability: "pause_workspace_runs",
        outcome: "success",
        occurredAt: NOW,
        ip: "203.0.113.9",
        userAgent: null,
        requestId: "req_1",
        detail: {
          reason: "Incident 42",
          queued: 1,
          commandIds: ["tcm_1"],
          // The event names the run and the reason. The agent key and the
          // failed row's id stay on the receipt and on the row.
          skipped: [{ runId: offline.publicId, reason: "host_offline" }],
        },
      },
    ]);
  });
});
