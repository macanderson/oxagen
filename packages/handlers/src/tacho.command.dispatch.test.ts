// dispatch_command: target resolution, the delivery-mode degradation rule,
// broadcast ceilings, supersession and the refusals, against an in-memory
// store that keeps the CommandStore contract. The role gate runs against a
// faked tenant transaction the way the CLI authorize test fakes it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  HandlerError,
  isHandlerError,
  type CapabilityContext,
} from "@oxagen/oxagen";
import { tachoCommandDispatch } from "@oxagen/oxagen/contracts/tacho.command.dispatch";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  addressOf,
  BUNDLE_FEATURE_STEER_NEXT_STEP,
  type CommandRowInput,
  type CommandStore,
  createDispatchCommandHandler,
  type NextRunCommandInput,
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

/** The user the API key in these tests was created by. */
const KEY_CREATOR = "00000000-0000-4000-8000-0000000000c7";

/** An API-key call: no signed-in user, the key's id. */
const KEY_CALL: CapabilityContext = {
  ...OPERATOR,
  userId: null,
  apiKeyId: "00000000-0000-4000-8000-0000000000a9",
  surface: "mcp",
};

const dialect = new PgDialect();

/**
 * The role queries `resolveActingUserId` and `assertOrgRole` run, answered by
 * the table read and the scope the WHERE pinned: the API key's creator
 * (`keyCreator`, null for a key with none); an org-wide assignment has
 * `workspace_id is null`, a workspace assignment carries the id.
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

type Row = CommandRowInput & { publicId: string };

function session(over: Partial<RecipientSession> = {}): RecipientSession {
  return {
    id: "s1",
    publicId: "tse_0123456789abcdefghjkmn",
    sessionUuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
    hostId: "11111111-1111-4111-8111-111111111111",
    agentKey: "acme.core.cc-laptop",
    runtime: "claude-code",
    outcome: "running",
    enforcementTier: "harness",
    host: {
      status: "active",
      lastSeenAt: new Date(NOW.getTime() - 30_000),
      bundleFeatures: [],
    },
    ...over,
  };
}

/** A host that polled within the window and can carry a step steer. */
const STEP_HOST = {
  status: "active",
  lastSeenAt: new Date(NOW.getTime() - 30_000),
  bundleFeatures: [BUNDLE_FEATURE_STEER_NEXT_STEP],
};

/** A command held for an agent's next run, as the store keeps it. */
type NextRunRow = NextRunCommandInput & {
  publicId: string;
  outcome: string;
  outcomeDetail: string | null;
};

class MemoryStore implements CommandStore {
  rows: Row[] = [];
  cancelled: Array<{ publicId: string; detail: string }> = [];
  /** Commands held for an idle agent's next run (#2953). */
  nextRun: NextRunRow[] = [];
  /** The agent keys an enrolled host in the scope carries. */
  enrolledAgents = new Set(["acme.core.cc-laptop", "acme.core.idle"]);
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
  async cancelLedgerRun({ publicId }: { publicId: string }) {
    if (!this.ledgerRuns.includes(publicId)) throw new Error("run_not_found");
    return "tcm_ledger_cancel";
  }
  async setLedgerPaused({
    publicId,
    command,
  }: {
    publicId: string;
    command: "pause" | "resume";
  }) {
    if (!this.ledgerRuns.includes(publicId))
      throw new HandlerError({ code: "not_found", reason: "run_not_found" });
    return `tcm_ledger_${command}`;
  }
  async ledgerRunExists(_scope: unknown, publicId: string) {
    return this.ledgerRuns.includes(publicId);
  }
  async insert(row: CommandRowInput) {
    const publicId = `tcm_${++this.seq}`;
    this.rows.push({ ...row, publicId });
    return { publicId };
  }
  async queueForNextRun(row: NextRunCommandInput) {
    if (!this.enrolledAgents.has(row.agentKey)) return null;
    const publicId = `tcm_${++this.seq}`;
    for (const earlier of this.nextRun) {
      if (
        earlier.agentKey === row.agentKey &&
        earlier.command === row.command &&
        earlier.outcome === "queued"
      ) {
        earlier.outcome = "cancelled";
        earlier.outcomeDetail = `superseded_by:${publicId}`;
      }
    }
    this.nextRun.push({
      ...row,
      publicId,
      outcome: "queued",
      outcomeDetail: null,
    });
    return publicId;
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
const refused = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "forbidden" && e.reason === reason;

const RUN = session().publicId;

beforeEach(() => {
  vi.clearAllMocks();
  tenant("Admin");
});

// #4023: the host delivers steering text only at the next
// prompt, so a mode it cannot carry is recorded as the one it will.
describe("resolveDeliveryMode", () => {
  const carrier = [BUNDLE_FEATURE_STEER_NEXT_STEP];

  it("records next_step and interrupt as turn_boundary on a host with no step carrier", () => {
    for (const tier of ["harness", "gateway", "contained", "observe"]) {
      expect(resolveDeliveryMode("next_step", tier, [], "claude-code")).toEqual(
        {
          deliveryMode: "turn_boundary",
          degradedReason: "no_step_carrier",
        },
      );
      expect(resolveDeliveryMode("interrupt", tier, [], "claude-code")).toEqual(
        {
          deliveryMode: "turn_boundary",
          degradedReason: "no_step_carrier",
        },
      );
    }
  });

  it("carries turn_boundary on every host", () => {
    expect(
      resolveDeliveryMode("turn_boundary", "observe", [], "claude-code"),
    ).toEqual({
      deliveryMode: "turn_boundary",
      degradedReason: null,
    });
  });

  it("carries next_step where the host advertises a step carrier", () => {
    expect(
      resolveDeliveryMode("next_step", "harness", carrier, "claude-code"),
    ).toEqual({
      deliveryMode: "next_step",
      degradedReason: null,
    });
  });

  it("delivers interrupt only where the model proxy can cut the call", () => {
    expect(
      resolveDeliveryMode("interrupt", "contained", carrier, "claude-code"),
    ).toEqual({
      deliveryMode: "interrupt",
      degradedReason: null,
    });
    expect(
      resolveDeliveryMode("interrupt", "gateway", carrier, "claude-code"),
    ).toEqual({
      deliveryMode: "interrupt",
      degradedReason: null,
    });
    expect(
      resolveDeliveryMode("interrupt", "harness", carrier, "claude-code"),
    ).toEqual({
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
    });
  });
});

// A host with the carrier still cannot move a Cursor steer earlier: Cursor's
// adapter delivers at Stop. (A Stella steer is refused before this runs.)
describe("resolveDeliveryMode by runtime", () => {
  const carrier = [BUNDLE_FEATURE_STEER_NEXT_STEP];

  it("carries next_step for Codex as for Claude Code", () => {
    expect(
      resolveDeliveryMode("next_step", "harness", carrier, "codex"),
    ).toEqual({
      deliveryMode: "next_step",
      degradedReason: null,
    });
  });

  it("records a Cursor steer at the turn boundary", () => {
    for (const runtime of ["cursor", "custom"]) {
      for (const mode of ["next_step", "interrupt"] as const) {
        expect(resolveDeliveryMode(mode, "gateway", carrier, runtime)).toEqual({
          deliveryMode: "turn_boundary",
          degradedReason: "no_step_carrier",
        });
      }
    }
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
  it.each(["Owner", "Admin"])("an org %s dispatches", async (role) => {
    tenant(role);
    const store = new MemoryStore([session()]);
    const { commandIds } = await handlerOver(store)(
      parse({ target: { kind: "run", id: RUN }, command: "pause" }),
      OPERATOR,
    );
    expect(commandIds).toHaveLength(1);
  });

  it.each(["Owner", "Member"])(
    "a workspace %s with no qualifying org role dispatches in the run's workspace",
    async (role) => {
      tenant("Member", role);
      const store = new MemoryStore([session()]);
      const { commandIds } = await handlerOver(store)(
        parse({ target: { kind: "run", id: RUN }, command: "pause" }),
        OPERATOR,
      );
      expect(commandIds).toHaveLength(1);
    },
  );

  it("refuses an org Member with no workspace role, a workspace Viewer, and a context with no user (negative)", async () => {
    const store = new MemoryStore([session()]);
    const input = parse({ target: { kind: "run", id: RUN }, command: "pause" });
    tenant("Member");
    await expect(handlerOver(store)(input, OPERATOR)).rejects.toSatisfy(
      forbidden,
    );
    tenant("Member", "Viewer");
    await expect(handlerOver(store)(input, OPERATOR)).rejects.toSatisfy(
      forbidden,
    );
    tenant("Owner", "Owner");
    await expect(
      handlerOver(store)(input, { ...OPERATOR, userId: null }),
    ).rejects.toSatisfy(forbidden);
    expect(store.rows).toEqual([]);
  });

  describe("an API-key call acts as the key's creator", () => {
    const input = () =>
      parse({ target: { kind: "run", id: RUN }, command: "pause" });

    it("dispatches for a creator who is an org Admin, recorded as the issuer", async () => {
      tenant("Admin");
      const store = new MemoryStore([session()]);
      const { commandIds } = await handlerOver(store)(input(), KEY_CALL);
      expect(commandIds).toHaveLength(1);
      expect(store.rows[0]?.issuedByUserId).toBe(KEY_CREATOR);
    });

    it("refuses a key whose creator is an org Member with no workspace role (negative)", async () => {
      tenant("Member");
      const store = new MemoryStore([session()]);
      await expect(handlerOver(store)(input(), KEY_CALL)).rejects.toSatisfy(
        refused("org_role_required"),
      );
      expect(store.rows).toEqual([]);
    });

    it("refuses a key with no creator (negative)", async () => {
      tenant("Owner", "Owner", null);
      const store = new MemoryStore([session()]);
      await expect(handlerOver(store)(input(), KEY_CALL)).rejects.toSatisfy(
        refused("no_principal"),
      );
      expect(store.rows).toEqual([]);
    });
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
            // No host here advertises a step carrier.
            expect(row.deliveryMode).toBe("turn_boundary");
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
  // #4023: production steers asked for next_step, were recorded as next_step,
  // and expired an hour later waiting for a prompt the host never reached.
  it("records next_step as turn_boundary on a host with no step carrier", async () => {
    const store = new MemoryStore([session()]);
    await handlerOver(store)(
      parse({
        target: { kind: "run", id: RUN },
        command: "steer",
        payload: { text: "use staging", requestedMode: "next_step" },
      }),
      OPERATOR,
    );
    expect(store.rows[0]).toMatchObject({
      requestedMode: "next_step",
      deliveryMode: "turn_boundary",
      degradedReason: "no_step_carrier",
    });
  });

  it("records interrupt as requested and next_step as achieved, with harness_tier", async () => {
    const store = new MemoryStore([session({ host: STEP_HOST })]);
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

  it("queues a command for a run Oxagen closed for silence: its harness may be alive (#3980)", async () => {
    const store = new MemoryStore([
      session({ outcome: "unknown", sealSource: "idle_timeout" }),
    ]);
    await handlerOver(store)(
      parse({ target: { kind: "run", id: RUN }, command: "pause" }),
      OPERATOR,
    );
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ outcome: "queued" });
  });

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
  ] as const)("a run whose host cannot carry it: %s", async (reason, host) => {
    const store = new MemoryStore([session({ host })]);
    await expect(
      handlerOver(store)(
        parse({
          target: { kind: "run", id: RUN },
          command: "steer",
          payload: { text: "x" },
        }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(conflict(reason));
    expect(store.rows).toEqual([]);
  });

  // #4023: Stella's adapter hands steering text to the agent only at
  // SessionStart, which a live run has already passed.
  it("refuses a steer to a live Stella run, and queues its pause", async () => {
    const store = new MemoryStore([session({ runtime: "stella" })]);
    await expect(
      handlerOver(store)(
        parse({
          target: { kind: "run", id: RUN },
          command: "steer",
          payload: { text: "x" },
        }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(conflict("no_prompt_carrier"));
    expect(store.rows).toEqual([]);
    await handlerOver(store)(
      parse({ target: { kind: "run", id: RUN }, command: "pause" }),
      OPERATOR,
    );
    expect(store.rows.map((r) => r.outcome)).toEqual(["queued"]);
  });

  it("records a broadcast steer to a Stella run as failed with the reason", async () => {
    const store = new MemoryStore([session({ runtime: "stella" })]);
    await handlerOver(store)(
      parse({
        target: { kind: "workspace", id: WORKSPACE },
        command: "steer",
        payload: { text: "all hands" },
      }),
      OPERATOR,
    );
    expect(store.rows[0]).toMatchObject({
      outcome: "failed",
      outcomeDetail: "no_prompt_carrier",
      deliveryMode: null,
    });
  });

  // A message carries text the way a steer does, and the commands that carry
  // none still reach the Stella run.
  it("refuses a message to a live Stella run, and queues its resume and cancel", async () => {
    const store = new MemoryStore([session({ runtime: "stella" })]);
    await expect(
      handlerOver(store)(
        parse({
          target: { kind: "run", id: RUN },
          command: "message",
          payload: { text: "Wrap up." },
        }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(conflict("no_prompt_carrier"));
    expect(store.rows).toEqual([]);
    for (const command of ["resume", "cancel"] as const) {
      await handlerOver(store)(
        parse({ target: { kind: "run", id: RUN }, command }),
        OPERATOR,
      );
    }
    expect(store.rows.map((r) => [r.command, r.outcome])).toEqual([
      ["resume", "queued"],
      ["cancel", "queued"],
    ]);
  });

  it("fails a broadcast's Stella recipient and queues the rest", async () => {
    const store = new MemoryStore([
      session({ host: STEP_HOST }),
      session({
        id: "s2",
        publicId: "tse_1123456789abcdefghjkmn",
        sessionUuid: "4f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
        runtime: "stella",
        host: STEP_HOST,
      }),
    ]);
    const { commandIds } = await handlerOver(store)(
      parse({
        target: { kind: "workspace", id: WORKSPACE },
        command: "steer",
        payload: { text: "Wrap up." },
      }),
      OPERATOR,
    );
    expect(commandIds).toHaveLength(2);
    expect(
      store.rows.map((r) => [
        r.session.runtime,
        r.outcome,
        r.outcomeDetail,
        r.deliveryMode,
      ]),
    ).toEqual([
      ["claude-code", "queued", null, "next_step"],
      ["stella", "failed", "no_prompt_carrier", null],
    ]);
  });

  it("cancels a ledger run through its transactional cancellation seam", async () => {
    const ledger = "arun_cancel1";
    const store = new MemoryStore([], [ledger]);
    const cancel = vi.spyOn(store, "cancelLedgerRun");
    await expect(
      handlerOver(store)(
        parse({ target: { kind: "run", id: ledger }, command: "cancel" }),
        OPERATOR,
      ),
    ).resolves.toEqual({ commandIds: ["tcm_ledger_cancel"] });
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { orgId: ORG, workspaceId: WORKSPACE },
        publicId: ledger,
        userId: OPERATOR.userId,
        now: NOW,
      }),
    );
    expect(store.rows).toHaveLength(0);
  });

  it.each(["pause", "resume"] as const)(
    "dispatches ledger %s through the ingress transaction",
    async (command) => {
      const ledger = "arun_5f0c2e9a1b7d4c3e8f6a02";
      const store = new MemoryStore([], [ledger]);
      const control = vi.spyOn(store, "setLedgerPaused");
      await expect(
        handlerOver(store)(
          parse({ target: { kind: "run", id: ledger }, command }),
          OPERATOR,
        ),
      ).resolves.toEqual({ commandIds: [`tcm_ledger_${command}`] });
      expect(control).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { orgId: ORG, workspaceId: WORKSPACE },
          publicId: ledger,
          command,
        }),
      );
      expect(store.rows).toEqual([]);
    },
  );

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

// ADR-163, #4023: the observe tier governs policy verdicts. It never takes
// away the operator's ability to stop their own agent.
describe("dispatch_command — an observe-tier run with a live host", () => {
  it.each(["pause", "resume", "cancel"] as const)(
    "queues %s",
    async (command) => {
      const store = new MemoryStore([session({ enforcementTier: "observe" })]);
      const { commandIds } = await handlerOver(store)(
        parse({ target: { kind: "run", id: RUN }, command }),
        OPERATOR,
      );
      expect(commandIds).toHaveLength(1);
      expect(store.rows[0]).toMatchObject({ outcome: "queued", command });
    },
  );

  it("queues a steer at the boundary the host can carry", async () => {
    const store = new MemoryStore([session({ enforcementTier: "observe" })]);
    await handlerOver(store)(
      parse({
        target: { kind: "run", id: RUN },
        command: "steer",
        payload: { text: "stop touching prod", requestedMode: "interrupt" },
      }),
      OPERATOR,
    );
    expect(store.rows[0]).toMatchObject({
      outcome: "queued",
      requestedMode: "interrupt",
      deliveryMode: "turn_boundary",
      degradedReason: "no_step_carrier",
    });
  });
});

describe("dispatch_command — broadcast", () => {
  const fleet = [
    session({ host: STEP_HOST }),
    session({
      id: "s2",
      publicId: "tse_2222222222222222222222",
      sessionUuid: "4f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6c",
      enforcementTier: "gateway",
      host: STEP_HOST,
    }),
    session({
      id: "s3",
      publicId: "tse_3333333333333333333333",
      sessionUuid: "5f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6d",
      enforcementTier: "observe",
      host: { ...STEP_HOST, lastSeenAt: new Date(NOW.getTime() - 3_600_000) },
    }),
    session({
      id: "s4",
      publicId: "tse_4444444444444444444444",
      sessionUuid: "6f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6e",
      outcome: "completed",
    }),
  ];

  it("reaches every live run, records the run whose host went quiet as failed with the reason, and never enumerates a sealed one", async () => {
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
    const offline = store.rows[2];
    expect(offline).toMatchObject({
      outcomeDetail: "host_offline",
      requestedMode: "interrupt",
      deliveryMode: null,
      degradedReason: null,
    });
    // The ceiling: each reachable recipient resolves at or below interrupt.
    // The harness run cannot be cut mid-call, so it degrades and says so.
    expect(store.rows[0]).toMatchObject({
      requestedMode: "interrupt",
      deliveryMode: "next_step",
      degradedReason: "harness_tier",
    });
    // The gateway run's model traffic is routed, so interrupt is real there.
    expect(store.rows[1]).toMatchObject({
      requestedMode: "interrupt",
      deliveryMode: "interrupt",
      degradedReason: null,
    });
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

// #2953: a steer to an agent with no run in flight waits for its next run.
describe("dispatch_command: a steer for an idle agent's next run", () => {
  const busy = [session()];

  it("queues one row for the agent's next run, addressed to the agent and carrying no session", async () => {
    const store = new MemoryStore(busy);
    const output = await handlerOver(store)(
      parse({
        target: { kind: "agent", id: "acme.core.idle" },
        command: "steer",
        payload: { text: "Skip the mobile repo.", requestedMode: "interrupt" },
        reason: "platform release only",
      }),
      OPERATOR,
    );
    expect(store.rows).toEqual([]);
    expect(store.nextRun).toHaveLength(1);
    const [row] = store.nextRun;
    expect(output.commandIds).toEqual([row?.publicId]);
    expect(row).toMatchObject({
      agentKey: "acme.core.idle",
      command: "steer",
      payload: { address: "@acme.core.idle", text: "Skip the mobile repo." },
      requestedMode: "interrupt",
      reason: "platform release only",
      issuedByUserId: OPERATOR.userId,
      outcome: "queued",
    });
    // The run is not known yet, so nothing names a session or a mode.
    expect(row?.payload["session_uuid"]).toBeUndefined();
    expect(row?.expiresAt.getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it("holds a message the same way", async () => {
    const store = new MemoryStore(busy);
    const output = await handlerOver(store)(
      parse({
        target: { kind: "agent", id: "acme.core.idle" },
        command: "message",
        payload: { text: "fyi: deploy at 5" },
      }),
      OPERATOR,
    );
    expect(output.commandIds).toHaveLength(1);
    expect(store.nextRun[0]).toMatchObject({
      command: "message",
      requestedMode: "next_step",
    });
  });

  it("sends a pause, resume or cancel for an idle agent nowhere (negative)", async () => {
    for (const command of ["pause", "resume", "cancel"] as const) {
      const store = new MemoryStore(busy);
      const output = await handlerOver(store)(
        parse({ target: { kind: "agent", id: "acme.core.idle" }, command }),
        OPERATOR,
      );
      expect(output.commandIds).toEqual([]);
      expect(store.rows).toEqual([]);
      expect(store.nextRun).toEqual([]);
    }
  });

  it("steers an agent with a run in flight on that run, not its next (negative)", async () => {
    const store = new MemoryStore(busy);
    const output = await handlerOver(store)(
      parse({
        target: { kind: "agent", id: "acme.core.cc-laptop" },
        command: "steer",
        payload: { text: "Skip the mobile repo." },
      }),
      OPERATOR,
    );
    expect(output.commandIds).toHaveLength(1);
    expect(store.rows.map((r) => r.session.publicId)).toEqual([RUN]);
    expect(store.nextRun).toEqual([]);
  });

  it("queues nothing for an agent no enrolled host carries (negative)", async () => {
    const store = new MemoryStore(busy);
    store.enrolledAgents.delete("acme.core.idle");
    const output = await handlerOver(store)(
      parse({
        target: { kind: "agent", id: "acme.core.idle" },
        command: "steer",
        payload: { text: "Skip the mobile repo." },
      }),
      OPERATOR,
    );
    expect(output.commandIds).toEqual([]);
    expect(store.nextRun).toEqual([]);
  });

  it("supersedes an earlier steer held for the same agent and leaves its message", async () => {
    const store = new MemoryStore(busy);
    const handler = handlerOver(store);
    const steer = (text: string) =>
      handler(
        parse({
          target: { kind: "agent", id: "acme.core.idle" },
          command: "steer",
          payload: { text },
        }),
        OPERATOR,
      );
    const first = await steer("Use staging.");
    await handler(
      parse({
        target: { kind: "agent", id: "acme.core.idle" },
        command: "message",
        payload: { text: "fyi" },
      }),
      OPERATOR,
    );
    const second = await steer("Use the read replica.");
    const byId = new Map(store.nextRun.map((row) => [row.publicId, row]));
    expect(byId.get(first.commandIds[0] ?? "")).toMatchObject({
      outcome: "cancelled",
      outcomeDetail: `superseded_by:${second.commandIds[0]}`,
    });
    expect(
      store.nextRun
        .filter((row) => row.outcome === "queued")
        .map((row) => row.command),
    ).toEqual(["message", "steer"]);
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

// A steer reaches the agent as hook `additionalContext`, which Claude Code
// keeps whole only up to 10,000 characters (`STEER_TEXT_MAX`).
describe("dispatch_command — steer text", () => {
  it("is refused past 8,000 characters", () => {
    expect(() =>
      parse({
        target: { kind: "run", id: RUN },
        command: "steer",
        payload: { text: "x".repeat(8_001) },
      }),
    ).toThrow();
    expect(
      parse({
        target: { kind: "run", id: RUN },
        command: "steer",
        payload: { text: "x".repeat(8_000) },
      }).payload?.text,
    ).toHaveLength(8_000);
  });
});
