// dispatch_command: target resolution, the delivery-mode degradation rule,
// broadcast ceilings, supersession and the refusals, against an in-memory
// store that keeps the CommandStore contract. The role gate runs against a
// faked tenant transaction the way the CLI authorize test fakes it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isHandlerError, type CapabilityContext } from "@oxagen/oxagen";
import { tachoCommandDispatch } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  addressOf,
  type CommandRowInput,
  type CommandStore,
  createDispatchCommandHandler,
  type RecipientSession,
  resolveDeliveryMode,
} from "./tacho.command.dispatch";

const ORG = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-09-14T10:00:00.000Z");

const OPERATOR: CapabilityContext = {
  orgId: ORG,
  workspaceId: WORKSPACE,
  userId: "00000000-0000-4000-8000-0000000000aa",
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

/** The role query `assertOrgRole` runs, answered by table. */
function tenant(roleName: string | null) {
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        select: () => ({
          from: (table: unknown) => {
            const chain = {
              innerJoin: () => chain,
              where: () => chain,
              limit: () =>
                Promise.resolve(
                  table === schema.principals
                    ? [{ id: "prn_1" }]
                    : roleName
                      ? [{ roleName }]
                      : [],
                ),
            };
            return chain;
          },
        }),
      }),
    ),
  );
}

type Row = CommandRowInput & { publicId: string };

function session(over: Partial<RecipientSession> = {}): RecipientSession {
  return {
    id: "s1",
    publicId: "tse_0123456789abcdefghjkmn",
    sessionUuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
    hostId: "11111111-1111-4111-8111-111111111111",
    agentKey: "acme.core.cc-laptop",
    outcome: "running",
    enforcementTier: "harness",
    ...over,
  };
}

class MemoryStore implements CommandStore {
  rows: Row[] = [];
  cancelled: Array<{ publicId: string; detail: string }> = [];
  private seq = 0;
  constructor(
    readonly sessions: RecipientSession[],
    readonly ledgerRuns: string[] = [],
    /** Rows already on the table before this dispatch, as `[runId, command, outcome]`. */
    existing: Array<[string, string, string]> = [],
  ) {
    for (const [runId, command, outcome] of existing) {
      this.rows.push({
        publicId: `tcm_existing_${this.rows.length}`,
        scope: { orgId: ORG, workspaceId: WORKSPACE },
        session: session({ publicId: runId }),
        command: command as Row["command"],
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
  async session(_scope: unknown, publicId: string) {
    return this.sessions.find((s) => s.publicId === publicId) ?? null;
  }
  async liveSessions(_scope: unknown, agentKey: string | null) {
    return this.sessions.filter(
      (s) =>
        s.outcome === "running" &&
        (agentKey === null || s.agentKey === agentKey),
    );
  }
  async ledgerRunExists(_scope: unknown, publicId: string) {
    return this.ledgerRuns.includes(publicId);
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

function handlerOver(store: CommandStore) {
  return createDispatchCommandHandler({
    withStore: (fn) => fn(store),
    now: () => NOW,
  });
}

const parse = (input: unknown) => tachoCommandDispatch.input.parse(input);
const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;
const notFound = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "not_found" && e.reason === reason;
const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";

const RUN = session().publicId;

beforeEach(() => {
  vi.clearAllMocks();
  tenant("Admin");
});

describe("resolveDeliveryMode", () => {
  it("carries next_step and turn_boundary and degrades interrupt to next_step with the reason", () => {
    expect(resolveDeliveryMode("next_step")).toEqual({
      deliveryMode: "next_step",
      degradedReason: null,
    });
    expect(resolveDeliveryMode("turn_boundary")).toEqual({
      deliveryMode: "turn_boundary",
      degradedReason: null,
    });
    expect(resolveDeliveryMode("interrupt")).toEqual({
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
    });
  });
});

describe("addressOf", () => {
  it("records the §7.6 address", () => {
    expect(addressOf({ kind: "run", id: RUN })).toBe(RUN);
    expect(addressOf({ kind: "agent", id: "acme.core.bot" })).toBe(
      "@acme.core.bot",
    );
    expect(addressOf({ kind: "workspace", id: WORKSPACE })).toBe("@agents");
  });
});

describe("dispatch_command — role gate", () => {
  it("refuses a Member and a context with no user (negative)", async () => {
    tenant("Member");
    const store = new MemoryStore([session()]);
    await expect(
      handlerOver(store)(
        parse({ target: { kind: "run", id: RUN }, command: "pause" }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(forbidden);
    await expect(
      handlerOver(store)(
        parse({ target: { kind: "run", id: RUN }, command: "pause" }),
        { ...OPERATOR, userId: null },
      ),
    ).rejects.toSatisfy(forbidden);
    expect(store.rows).toEqual([]);
  });
});

describe("dispatch_command — every command on every target kind", () => {
  const live = [
    session(),
    session({
      id: "s2",
      publicId: "tse_2222222222222222222222",
      sessionUuid: "4f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6c",
      agentKey: "acme.core.other",
    }),
  ];
  const targets = [
    { kind: "run", id: RUN, recipients: [RUN] },
    { kind: "agent", id: "acme.core.cc-laptop", recipients: [RUN] },
    {
      kind: "workspace",
      id: WORKSPACE,
      recipients: live.map((s) => s.publicId),
    },
  ] as const;
  const commands = [
    { command: "pause", reason: "budget review" },
    { command: "resume" },
    { command: "cancel", reason: "wrong branch" },
    { command: "steer", payload: { text: "use the staging db" } },
    { command: "message", payload: { text: "fyi: deploy at 5" } },
  ] as const;

  for (const target of targets) {
    for (const spec of commands) {
      it(`${spec.command} → ${target.kind}: one queued row per recipient, addressed to the run`, async () => {
        const store = new MemoryStore(live);
        const { recipients, ...t } = target;
        const output = await handlerOver(store)(
          parse({ target: t, ...spec }),
          OPERATOR,
        );
        expect(output.commandIds).toHaveLength(recipients.length);
        expect(store.rows.map((r) => r.session.publicId)).toEqual(recipients);
        for (const row of store.rows) {
          expect(row.outcome).toBe("queued");
          expect(row.command).toBe(spec.command);
          expect(row.payload["address"]).toBe(addressOf(t));
          expect(row.payload["session_uuid"]).toBe(row.session.sessionUuid);
          expect(row.reason).toBe("reason" in spec ? spec.reason : null);
          expect(row.issuedByUserId).toBe(OPERATOR.userId);
          expect(row.expiresAt.getTime() - NOW.getTime()).toBe(3_600_000);
          if ("payload" in spec) {
            expect(row.payload["text"]).toBe(spec.payload.text);
            expect(row.requestedMode).toBe("next_step");
            expect(row.deliveryMode).toBe("next_step");
          } else {
            expect(row.payload["text"]).toBeUndefined();
            expect(row.requestedMode).toBeNull();
            expect(row.deliveryMode).toBeNull();
          }
        }
      });
    }
  }
});

describe("dispatch_command — the degradation rule", () => {
  it("records interrupt as requested and next_step as achieved, with harness_tier", async () => {
    const store = new MemoryStore([session()]);
    await handlerOver(store)(
      parse({
        target: { kind: "run", id: RUN },
        command: "steer",
        payload: { text: "stop", requestedMode: "interrupt" },
      }),
      OPERATOR,
    );
    expect(store.rows[0]).toMatchObject({
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
    });
  });

  it("carries turn_boundary as asked, with no degradation", async () => {
    const store = new MemoryStore([session({ enforcementTier: "gateway" })]);
    await handlerOver(store)(
      parse({
        target: { kind: "run", id: RUN },
        command: "steer",
        payload: { text: "new priority", requestedMode: "turn_boundary" },
      }),
      OPERATOR,
    );
    expect(store.rows[0]).toMatchObject({
      requestedMode: "turn_boundary",
      deliveryMode: "turn_boundary",
      degradedReason: null,
    });
  });
});

describe("dispatch_command — a direct target that cannot receive is refused, never queued", () => {
  it("a sealed run", async () => {
    const store = new MemoryStore([session({ outcome: "completed" })]);
    await expect(
      handlerOver(store)(
        parse({ target: { kind: "run", id: RUN }, command: "pause" }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(conflict("run_sealed"));
    expect(store.rows).toEqual([]);
  });

  it("an observe-tier run", async () => {
    const store = new MemoryStore([session({ enforcementTier: "observe" })]);
    await expect(
      handlerOver(store)(
        parse({
          target: { kind: "run", id: RUN },
          command: "steer",
          payload: { text: "x" },
        }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(conflict("observe_tier"));
    expect(store.rows).toEqual([]);
  });

  it("a ledger run, which has no connection point", async () => {
    const ledger = "arun_5f0c2e9a1b7d4c3e8f6a02";
    const store = new MemoryStore([], [ledger]);
    await expect(
      handlerOver(store)(
        parse({ target: { kind: "run", id: ledger }, command: "cancel" }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(conflict("no_connection_point"));
    expect(store.rows).toEqual([]);
  });

  it("a run neither store holds, and another workspace, are not found", async () => {
    const store = new MemoryStore([session()]);
    await expect(
      handlerOver(store)(
        parse({
          target: { kind: "run", id: "tse_9999999999999999999999" },
          command: "pause",
        }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(notFound("run_not_found"));
    await expect(
      handlerOver(store)(
        parse({
          target: { kind: "run", id: "arun_9999999999999999999999" },
          command: "pause",
        }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(notFound("run_not_found"));
    await expect(
      handlerOver(store)(
        parse({
          target: {
            kind: "workspace",
            id: "00000000-0000-4000-8000-000000000099",
          },
          command: "pause",
        }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(notFound("workspace_not_found"));
    expect(store.rows).toEqual([]);
  });
});

describe("dispatch_command — broadcast", () => {
  const fleet = [
    session(),
    session({
      id: "s2",
      publicId: "tse_2222222222222222222222",
      sessionUuid: "4f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6c",
      enforcementTier: "gateway",
    }),
    session({
      id: "s3",
      publicId: "tse_3333333333333333333333",
      sessionUuid: "5f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6d",
      enforcementTier: "observe",
    }),
    session({
      id: "s4",
      publicId: "tse_4444444444444444444444",
      sessionUuid: "6f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6e",
      outcome: "completed",
    }),
  ];

  it("reaches every live run, records the observe-tier run as failed with the reason, and never enumerates a sealed one", async () => {
    const store = new MemoryStore(fleet);
    const output = await handlerOver(store)(
      parse({
        target: { kind: "workspace", id: WORKSPACE },
        command: "steer",
        payload: { text: "all hands", requestedMode: "interrupt" },
      }),
      OPERATOR,
    );
    expect(output.commandIds).toHaveLength(3);
    expect(store.rows.map((r) => [r.session.publicId, r.outcome])).toEqual([
      [fleet[0]?.publicId, "queued"],
      [fleet[1]?.publicId, "queued"],
      [fleet[2]?.publicId, "failed"],
    ]);
    const observe = store.rows[2];
    expect(observe).toMatchObject({
      outcomeDetail: "observe_tier",
      requestedMode: "interrupt",
      deliveryMode: null,
      degradedReason: null,
    });
    // The ceiling: each reachable recipient resolves at or below interrupt.
    for (const row of store.rows.slice(0, 2)) {
      expect(row).toMatchObject({
        requestedMode: "interrupt",
        deliveryMode: "next_step",
        degradedReason: "harness_tier",
      });
    }
    // The failed row is never a supersession candidate.
    expect(store.cancelled).toEqual([]);
  });

  it("an agent address reaches only that agent's live runs, and an empty fleet answers no ids", async () => {
    const store = new MemoryStore(fleet);
    const output = await handlerOver(store)(
      parse({
        target: { kind: "agent", id: "acme.core.cc-laptop" },
        command: "pause",
      }),
      OPERATOR,
    );
    expect(output.commandIds).toHaveLength(3);
    const empty = new MemoryStore(fleet);
    expect(
      (
        await handlerOver(empty)(
          parse({
            target: { kind: "agent", id: "acme.core.nobody" },
            command: "pause",
          }),
          OPERATOR,
        )
      ).commandIds,
    ).toEqual([]);
    expect(empty.rows).toEqual([]);
  });
});

describe("dispatch_command — supersession", () => {
  it("cancels an earlier queued command of the same kind on the same run and leaves the others", async () => {
    const store = new MemoryStore(
      [session()],
      [],
      [
        [RUN, "steer", "queued"],
        [RUN, "steer", "sent"],
        [RUN, "pause", "queued"],
        ["tse_2222222222222222222222", "steer", "queued"],
      ],
    );
    const output = await handlerOver(store)(
      parse({
        target: { kind: "run", id: RUN },
        command: "steer",
        payload: { text: "second thoughts" },
      }),
      OPERATOR,
    );
    expect(store.cancelled).toEqual([
      {
        publicId: "tcm_existing_0",
        detail: `superseded_by:${output.commandIds[0]}`,
      },
    ]);
  });
});
