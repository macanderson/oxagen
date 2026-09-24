// seal_run: the role gate, the refusals, the seal of the root and its open
// chains, and the kill it queues or does not send, against an in-memory store
// that keeps the SealStore contract. The role gate runs against a faked
// tenant transaction the way the dispatch_command test fakes it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { runSeal } from "@oxagen/oxagen/contracts/run.seal";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("./logger", () => ({ logger: mocks.logger }));
vi.mock("./event-client", () => ({ eventClient: { send: vi.fn() } }));

import {
  createSealRunHandler,
  KILL_EXPIRES_IN_MS,
  type OperatorSealColumns,
  type RunSealedEvent,
  type SealableChain,
  type SealRoot,
  type SealStore,
} from "./run.seal";
import type { CommandRowInput } from "./tacho.command.dispatch";

const ORG = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-24T10:00:00.000Z");
const LAST_EVENT = new Date("2026-09-24T08:30:00.000Z");
const HEAD = `sha256:${"a".repeat(64)}`;

const OPERATOR: CapabilityContext = {
  orgId: ORG,
  workspaceId: WORKSPACE,
  userId: "00000000-0000-4000-8000-0000000000aa",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const dialect = new PgDialect();

/**
 * The role queries `resolveActingUserId` and `assertOrgRole` run, answered by
 * the table read and the scope the WHERE pinned: an org-wide assignment has
 * `workspace_id is null`, a workspace assignment carries the id.
 */
function tenant(orgRole: string | null, workspaceRole: string | null = null) {
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

const RUN = "tse_0123456789abcdefghjkmn";
const ROOT_UUID = "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b";

/** A host that polled thirty seconds ago. */
const POLLING = {
  status: "active",
  lastSeenAt: new Date(NOW.getTime() - 30_000),
  bundleFeatures: [],
};

/** One chain as the store holds it: the session, its run and its seal. */
type Chain = SealRoot &
  SealableChain & {
    rootSessionUuid: string;
    parentSessionUuid: string | null;
    /** What the seal wrote, once it has. */
    written?: OperatorSealColumns;
  };

function chain(over: Partial<Chain> = {}): Chain {
  return {
    id: "s1",
    publicId: RUN,
    sessionUuid: ROOT_UUID,
    rootSessionUuid: ROOT_UUID,
    parentSessionUuid: null,
    hostId: "11111111-1111-4111-8111-111111111111",
    agentKey: "acme.core.cc-laptop",
    runtime: "claude-code",
    outcome: "running",
    enforcementTier: "harness",
    host: POLLING,
    sealedAt: null,
    sealSource: null,
    lastHash: HEAD,
    lastEventAt: LAST_EVENT,
    chainVerified: true,
    telemetryGapCount: 0,
    contentFrames: 4,
    bodyFrames: 4,
    numToolCalls: 2,
    toolBodyFrames: 2,
    ...over,
  };
}

/** A subagent chain of RUN. */
function subagent(n: number, over: Partial<Chain> = {}): Chain {
  return chain({
    id: `s-sub-${n}`,
    publicId: `tse_sub${n}`,
    sessionUuid: `4f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6${n}`,
    parentSessionUuid: ROOT_UUID,
    ...over,
  });
}

type Row = CommandRowInput & { publicId: string };

class MemoryStore implements SealStore {
  rows: Row[] = [];
  cancelled: Array<{ publicId: string; detail: string }> = [];
  modes: string[] = [];
  /** A host seal that commits between the lock and the root's UPDATE. */
  hostSealsFirst = false;
  private seq = 0;
  constructor(
    readonly chains: Chain[],
    readonly ledgerRuns: string[] = [],
    readonly mode = "content_exact",
    /** Kill rows already on the table, as `[runId, outcome]`. */
    existing: Array<[string, string]> = [],
  ) {
    for (const [runId, outcome] of existing) {
      this.rows.push({
        publicId: `tcm_existing_${this.rows.length}`,
        scope: { orgId: ORG, workspaceId: WORKSPACE },
        session: chain({ publicId: runId }),
        command: "kill",
        payload: {},
        requestedMode: null,
        deliveryMode: null,
        degradedReason: null,
        reason: null,
        outcome: outcome as Row["outcome"],
        outcomeDetail: null,
        issuedByUserId: null,
        issuedAt: NOW,
        expiresAt: NOW,
      });
    }
  }
  private sealable(c: Chain) {
    return c.sealedAt === null || c.sealSource === "idle_timeout";
  }
  async ledgerRunExists(_scope: unknown, publicId: string) {
    return this.ledgerRuns.includes(publicId);
  }
  async lockRoot(_scope: unknown, publicId: string) {
    const root = this.chains.find(
      (c) => c.publicId === publicId && c.parentSessionUuid === null,
    );
    return root ? { ...root } : null;
  }
  async lockSealableChains(_scope: unknown, root: SealRoot) {
    return this.chains
      .filter(
        (c) =>
          (c.id === root.id || c.rootSessionUuid === root.sessionUuid) &&
          this.sealable(c),
      )
      .map((c) => ({ ...c }));
  }
  async retentionMode() {
    this.modes.push(this.mode);
    return this.mode;
  }
  async seal(_scope: unknown, chainId: string, columns: OperatorSealColumns) {
    const target = this.chains.find((c) => c.id === chainId);
    if (!target) return false;
    if (this.hostSealsFirst && target.parentSessionUuid === null)
      Object.assign(target, {
        sealedAt: NOW,
        sealSource: "agent_stop",
        outcome: "completed",
      });
    if (!this.sealable(target)) return false;
    Object.assign(target, columns, { written: columns });
    return true;
  }
  async insert(row: CommandRowInput) {
    const publicId = `tcm_${++this.seq}`;
    this.rows.push({ ...row, publicId });
    return { publicId };
  }
  async supersede(args: {
    runPublicId: string;
    command: string;
    successorPublicId: string;
  }) {
    let n = 0;
    for (const row of this.rows) {
      if (
        row.session.publicId === args.runPublicId &&
        row.command === args.command &&
        row.outcome === "queued" &&
        row.publicId !== args.successorPublicId
      ) {
        this.cancelled.push({
          publicId: row.publicId,
          detail: `superseded_by:${args.successorPublicId}`,
        });
        n += 1;
      }
    }
    return n;
  }
}

/** The handler over a store, recording when the transaction ends and what is sent. */
function handlerOver(store: SealStore) {
  const order: string[] = [];
  const sendEvent = vi.fn(async (_event: RunSealedEvent) => {
    order.push("send");
  });
  const handler = createSealRunHandler({
    withStore: async (fn) => {
      const out = await fn(store);
      order.push("commit");
      return out;
    },
    now: () => NOW,
    sendEvent,
  });
  return { handler, sendEvent, order };
}

const parse = (input: unknown) => runSeal.input.parse(input);
const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;
const notFound = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "not_found" && e.reason === reason;
const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";

beforeEach(() => {
  vi.clearAllMocks();
  tenant("Admin");
});

describe("seal_run: role gate", () => {
  it.each(["Owner", "Admin"])("an org %s seals", async (role) => {
    tenant(role);
    const store = new MemoryStore([chain()]);
    const out = await handlerOver(store).handler(
      parse({ runId: RUN }),
      OPERATOR,
    );
    expect(out.sessionsSealed).toBe(1);
  });

  it("a workspace Owner with no qualifying org role seals", async () => {
    tenant("Member", "Owner");
    const store = new MemoryStore([chain()]);
    const out = await handlerOver(store).handler(
      parse({ runId: RUN }),
      OPERATOR,
    );
    expect(out.sessionsSealed).toBe(1);
  });

  it("refuses a workspace Member, who may pause a run but not seal it, before any write (negative)", async () => {
    tenant("Member", "Member");
    const store = new MemoryStore([chain()]);
    const { handler, sendEvent } = handlerOver(store);
    await expect(handler(parse({ runId: RUN }), OPERATOR)).rejects.toSatisfy(
      forbidden,
    );
    expect(store.chains[0]?.sealedAt).toBeNull();
    expect(store.rows).toEqual([]);
    expect(sendEvent).not.toHaveBeenCalled();
  });
});

describe("seal_run: refusals", () => {
  it("refuses a ledger run: its producer seals it (negative)", async () => {
    const ledger = "arun_5f0c2e9a1b7d4c3e8f6a02";
    const store = new MemoryStore([chain()], [ledger]);
    const { handler, sendEvent } = handlerOver(store);
    const err = await handler(parse({ runId: ledger }), OPERATOR).catch(
      (e: unknown) => e,
    );
    expect(err).toSatisfy(conflict("ledger_run"));
    expect((err as Error).message).toMatch(/dispatch_command cancel/);
    expect(store.rows).toEqual([]);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("answers not found for a run neither store holds (negative)", async () => {
    const store = new MemoryStore([chain()]);
    const { handler, sendEvent } = handlerOver(store);
    await expect(
      handler(parse({ runId: "tse_9999999999999999999999" }), OPERATOR),
    ).rejects.toSatisfy(notFound("run_not_found"));
    await expect(
      handler(parse({ runId: "arun_9999999999999999999999" }), OPERATOR),
    ).rejects.toSatisfy(notFound("run_not_found"));
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["the host's agent_stop", "agent_stop", "completed"],
    ["an operator", "operator", "unknown"],
    ["a seal older than the column", null, "completed"],
  ] as const)(
    "refuses a run sealed by %s: that seal is final (negative)",
    async (_label, sealSource, outcome) => {
      const sealedAt = new Date("2026-09-24T09:00:00.000Z");
      const store = new MemoryStore([
        chain({ sealedAt, sealSource, outcome }),
        subagent(1),
      ]);
      const { handler, sendEvent } = handlerOver(store);
      const err = await handler(parse({ runId: RUN }), OPERATOR).catch(
        (e: unknown) => e,
      );
      expect(err).toSatisfy(conflict("run_sealed"));
      expect((err as Error).message).toBe("The run has already sealed");
      expect(store.chains[0]).toMatchObject({ sealedAt, sealSource, outcome });
      // Its open subagent is left alone too: nothing was written.
      expect(store.chains[1]?.sealedAt).toBeNull();
      expect(store.rows).toEqual([]);
      expect(sendEvent).not.toHaveBeenCalled();
    },
  );

  it("refuses when the host's own seal wins the race to the root, and queues no kill (negative)", async () => {
    const store = new MemoryStore([chain()]);
    store.hostSealsFirst = true;
    const { handler, sendEvent } = handlerOver(store);
    await expect(handler(parse({ runId: RUN }), OPERATOR)).rejects.toSatisfy(
      conflict("run_sealed"),
    );
    expect(store.chains[0]).toMatchObject({ sealSource: "agent_stop" });
    expect(store.rows).toEqual([]);
    expect(sendEvent).not.toHaveBeenCalled();
  });
});

describe("seal_run: a live run", () => {
  it("seals it as the operator's and queues a kill its polling host collects", async () => {
    const store = new MemoryStore([chain()]);
    const { handler } = handlerOver(store);
    const out = await handler(
      parse({ runId: RUN, reason: "finished, never sent a stop" }),
      OPERATOR,
    );

    expect(runSeal.output.parse(out)).toEqual(out);
    expect(out).toEqual({
      runId: RUN,
      sealedAt: NOW.toISOString(),
      sessionsSealed: 1,
      kill: { status: "queued", commandId: "tcm_1" },
    });
    // The idle close's columns, recorded as the operator's.
    expect(store.chains[0]?.written).toEqual({
      sealedAt: NOW,
      sealSource: "operator",
      outcome: "unknown",
      endedAt: LAST_EVENT,
      finalHash: HEAD,
      unobservedTail: true,
      completenessGaps: ["unobserved_tail"],
      replayGrade: "inspect",
      updatedAt: NOW,
    });
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      command: "kill",
      outcome: "queued",
      outcomeDetail: null,
      reason: "finished, never sent a stop",
      issuedByUserId: OPERATOR.userId,
      issuedAt: NOW,
      payload: { address: RUN, session_uuid: ROOT_UUID },
      requestedMode: null,
      deliveryMode: null,
      degradedReason: null,
    });
    expect(store.rows[0]?.session.publicId).toBe(RUN);
    expect(store.rows[0]?.expiresAt.getTime()).toBe(
      NOW.getTime() + KILL_EXPIRES_IN_MS,
    );
    expect(KILL_EXPIRES_IN_MS).toBe(3_600_000);
  });

  it("grades the seal by the workspace's retention mode", async () => {
    const store = new MemoryStore([chain()], [], "digest_only");
    await handlerOver(store).handler(parse({ runId: RUN }), OPERATOR);
    expect(store.chains[0]?.written?.completenessGaps).toEqual([
      "unobserved_tail",
      "digest_only",
    ]);
  });

  it("records no reason when the operator gave none", async () => {
    const store = new MemoryStore([chain()]);
    await handlerOver(store).handler(parse({ runId: RUN }), OPERATOR);
    expect(store.rows[0]?.reason).toBeNull();
  });

  it("supersedes an earlier queued kill for the run and leaves the others", async () => {
    const store = new MemoryStore([chain()], [], "content_exact", [
      [RUN, "queued"],
      [RUN, "sent"],
      ["tse_2222222222222222222222", "queued"],
    ]);
    const out = await handlerOver(store).handler(
      parse({ runId: RUN }),
      OPERATOR,
    );
    expect(out.kill).toEqual({ status: "queued", commandId: "tcm_1" });
    expect(store.cancelled).toEqual([
      { publicId: "tcm_existing_0", detail: "superseded_by:tcm_1" },
    ]);
  });
});

describe("seal_run: a run no host can take a kill for", () => {
  it.each([
    ["no_host", null],
    [
      "host_revoked",
      { status: "revoked", lastSeenAt: NOW, bundleFeatures: [] },
    ],
    [
      "host_offline",
      {
        status: "active",
        lastSeenAt: new Date(NOW.getTime() - 5 * 60_000 - 1),
        bundleFeatures: [],
      },
    ],
    [
      "host_offline",
      { status: "active", lastSeenAt: null, bundleFeatures: [] },
    ],
  ] as const)(
    "seals it and answers that the kill was not sent: %s",
    async (reason, host) => {
      const store = new MemoryStore([chain({ host })]);
      const out = await handlerOver(store).handler(
        parse({ runId: RUN }),
        OPERATOR,
      );
      expect(out.kill).toEqual({ status: "not_sent", reason });
      expect(out.sessionsSealed).toBe(1);
      expect(store.chains[0]).toMatchObject({
        sealSource: "operator",
        outcome: "unknown",
      });
      expect(store.rows).toEqual([]);
    },
  );
});

describe("seal_run: a run the control plane closed for silence", () => {
  const idle = {
    outcome: "unknown",
    sealedAt: new Date("2026-09-24T09:00:00.000Z"),
    sealSource: "idle_timeout",
  } as const;

  it("seals it for good, and queues the kill: its host still polls", async () => {
    const store = new MemoryStore([chain(idle)]);
    const out = await handlerOver(store).handler(
      parse({ runId: RUN }),
      OPERATOR,
    );
    expect(out.kill).toEqual({ status: "queued", commandId: "tcm_1" });
    expect(store.chains[0]).toMatchObject({
      sealedAt: NOW,
      sealSource: "operator",
      outcome: "unknown",
    });
  });

  it("seals it and sends no kill to a host that stopped polling", async () => {
    const store = new MemoryStore([
      chain({
        ...idle,
        host: { ...POLLING, lastSeenAt: new Date(NOW.getTime() - 3_600_000) },
      }),
    ]);
    const out = await handlerOver(store).handler(
      parse({ runId: RUN }),
      OPERATOR,
    );
    expect(out.kill).toEqual({ status: "not_sent", reason: "host_offline" });
    expect(store.chains[0]?.sealSource).toBe("operator");
    expect(store.rows).toEqual([]);
  });
});

describe("seal_run: the run's other chains", () => {
  it("seals every open or idle-closed chain with the root, counts them, and leaves a finished subagent's seal", async () => {
    const finishedAt = new Date("2026-09-24T09:10:00.000Z");
    const store = new MemoryStore([
      chain(),
      subagent(1),
      subagent(2, {
        sealedAt: new Date("2026-09-24T09:00:00.000Z"),
        sealSource: "idle_timeout",
        outcome: "unknown",
      }),
      subagent(3, {
        sealedAt: finishedAt,
        sealSource: "agent_stop",
        outcome: "completed",
      }),
      // Another run's chain.
      chain({
        id: "s-other",
        publicId: "tse_other",
        sessionUuid: "5f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6d",
        rootSessionUuid: "5f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6d",
      }),
    ]);
    const out = await handlerOver(store).handler(
      parse({ runId: RUN }),
      OPERATOR,
    );
    expect(out.sessionsSealed).toBe(3);
    const byId = new Map(store.chains.map((c) => [c.id, c]));
    for (const id of ["s1", "s-sub-1", "s-sub-2"])
      expect(byId.get(id)).toMatchObject({
        sealedAt: NOW,
        sealSource: "operator",
        outcome: "unknown",
      });
    expect(byId.get("s-sub-3")).toMatchObject({
      sealedAt: finishedAt,
      sealSource: "agent_stop",
      outcome: "completed",
    });
    expect(byId.get("s-other")).toMatchObject({
      sealedAt: null,
      outcome: "running",
    });
    // One kill, for the run's root.
    expect(store.rows).toHaveLength(1);
  });
});

describe("seal_run: cost/run.sealed", () => {
  it("is sent for the root after the transaction commits", async () => {
    const store = new MemoryStore([chain(), subagent(1)]);
    const { handler, sendEvent, order } = handlerOver(store);
    await handler(parse({ runId: RUN }), OPERATOR);
    expect(order).toEqual(["commit", "send"]);
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent).toHaveBeenCalledWith({
      name: "cost/run.sealed",
      data: { runId: RUN, orgId: ORG, workspaceId: WORKSPACE },
    });
  });

  it("does not fail the call when the send fails, and logs it", async () => {
    const store = new MemoryStore([chain()]);
    const { handler, sendEvent } = handlerOver(store);
    sendEvent.mockRejectedValueOnce(new Error("inngest down"));
    const out = await handler(parse({ runId: RUN }), OPERATOR);
    expect(out.kill.status).toBe("queued");
    expect(store.chains[0]?.sealSource).toBe("operator");
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: RUN }),
      expect.stringContaining("cost/run.sealed"),
    );
  });
});
