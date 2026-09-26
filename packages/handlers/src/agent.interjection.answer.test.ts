// answer_interjection (#3839): answering, answering twice, expiry, the run
// the answer reaches, and the role gate, against an in-memory store that
// keeps the InterjectionAnswerStore contract. The role gate runs against a
// faked tenant transaction, as dispatch_command's tests fake it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { type CapabilityContext, isHandlerError } from "@oxagen/oxagen";
import { agentInterjectionAnswer } from "@oxagen/oxagen/contracts/agent.interjection.answer";
import { schema } from "@oxagen/database";

const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is the same function as the tenant seam (ADR-086): the
  // role gate reads through withOrgDb.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("./logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import {
  answerCommand,
  createAnswerInterjectionHandler,
  type InterjectionAnswerStore,
  type LockedInterjection,
} from "./agent.interjection.answer";
import type {
  CommandRowInput,
  RecipientSession,
} from "./tacho.command.dispatch";

const ORG = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-09-25T09:10:00.000Z");
const EXPIRES = new Date("2026-09-25T09:30:00.000Z");

const OPERATOR: CapabilityContext = {
  orgId: ORG,
  workspaceId: WORKSPACE,
  userId: USER,
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

const dialect = new PgDialect();

/**
 * The role reads `assertOrgRole` makes, answered by the scope the WHERE
 * pinned: an org-wide assignment, or one on this workspace.
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

type Question = LockedInterjection & {
  orgId: string;
  workspaceId: string;
  answer: string | null;
  answeredBy: string | null;
};

function question(over: Partial<Question> = {}): Question {
  return {
    id: "0199a000-0000-7000-8000-000000000001",
    publicId: "inj_0123456789abcdefghjkmn",
    runPublicId: "tse_0123456789abcdefghjkmn",
    answeredAt: null,
    expiresAt: EXPIRES,
    orgId: ORG,
    workspaceId: WORKSPACE,
    answer: null,
    answeredBy: null,
    ...over,
  };
}

class MemoryStore implements InterjectionAnswerStore {
  queued: CommandRowInput[] = [];
  constructor(
    readonly questions: Question[],
    readonly sessions: RecipientSession[] = [session()],
  ) {}
  async lock(scope: { orgId: string; workspaceId: string }, id: string) {
    const q = this.questions.find(
      (x) =>
        (x.publicId === id || x.id === id) &&
        x.orgId === scope.orgId &&
        x.workspaceId === scope.workspaceId,
    );
    return q === undefined
      ? null
      : {
          id: q.id,
          publicId: q.publicId,
          runPublicId: q.runPublicId,
          answeredAt: q.answeredAt,
          expiresAt: q.expiresAt,
        };
  }
  async answer(args: {
    id: string;
    answer: string;
    userId: string | null;
    now: Date;
  }) {
    const q = this.questions.find((x) => x.id === args.id);
    if (!q || q.answeredAt !== null || q.expiresAt <= args.now) return false;
    q.answeredAt = args.now;
    q.answer = args.answer;
    q.answeredBy = args.userId;
    return true;
  }
  async session(_scope: unknown, publicId: string) {
    return this.sessions.find((s) => s.publicId === publicId) ?? null;
  }
  async queue(row: CommandRowInput) {
    this.queued.push(row);
    return { publicId: `tcm_${this.queued.length}` };
  }
}

function handlerFor(store: MemoryStore, now = NOW) {
  return createAnswerInterjectionHandler({
    withStore: (fn) => fn(store),
    now: () => now,
  });
}

const input = (over: Record<string, unknown> = {}) =>
  agentInterjectionAnswer.input.parse({
    interjectionId: "inj_0123456789abcdefghjkmn",
    answer: "Cut it from main.",
    ...over,
  });

const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;

beforeEach(() => {
  vi.clearAllMocks();
  tenant("Member", "Member");
});

describe("answer_interjection: answering", () => {
  it("records the answer, who gave it and when, and queues it to the wrapped run as a message", async () => {
    const store = new MemoryStore([question()]);
    const out = await handlerFor(store)(input(), OPERATOR);
    expect(agentInterjectionAnswer.output.parse(out)).toEqual({
      interjectionId: "inj_0123456789abcdefghjkmn",
      runId: "tse_0123456789abcdefghjkmn",
      answeredAt: NOW.toISOString(),
      commandIds: ["tcm_1"],
    });
    expect(store.questions[0]).toMatchObject({
      answeredAt: NOW,
      answer: "Cut it from main.",
      answeredBy: USER,
    });
    const [command] = store.queued;
    expect(command).toMatchObject({
      command: "message",
      outcome: "queued",
      issuedByUserId: USER,
      issuedAt: NOW,
      // The run stops waiting at the question's expiry, so the message does too.
      expiresAt: EXPIRES,
      payload: {
        address: "tse_0123456789abcdefghjkmn",
        session_uuid: "3f2b7a5e-8c1d-4e6f-9a0b-1c2d3e4f5a6b",
        text: "Cut it from main.",
        interjection_id: "inj_0123456789abcdefghjkmn",
      },
    });
  });

  it("finds the question by its row uuid as well as its public id", async () => {
    const store = new MemoryStore([question()]);
    const out = await handlerFor(store)(
      input({ interjectionId: "0199a000-0000-7000-8000-000000000001" }),
      OPERATOR,
    );
    expect(out.interjectionId).toBe("inj_0123456789abcdefghjkmn");
  });

  it("records a ledger run's answer on the question alone: no connection point, no command", async () => {
    const store = new MemoryStore([
      question({ runPublicId: "arun_0123456789abcdefghjkmn" }),
    ]);
    const out = await handlerFor(store)(input(), OPERATOR);
    expect(out.commandIds).toEqual([]);
    expect(store.queued).toEqual([]);
    expect(store.questions[0]?.answer).toBe("Cut it from main.");
  });

  it("queues nothing for a wrapped run whose host cannot take a command, and still records the answer", async () => {
    const offline = session({
      host: {
        status: "active",
        lastSeenAt: new Date(NOW.getTime() - 60 * 60_000),
        bundleFeatures: [],
      },
    });
    const store = new MemoryStore([question()], [offline]);
    const out = await handlerFor(store)(input(), OPERATOR);
    expect(out.commandIds).toEqual([]);
    expect(store.questions[0]?.answeredAt).toEqual(NOW);
  });

  it("queues nothing when the run names no session in scope", async () => {
    const store = new MemoryStore([question()], []);
    const out = await handlerFor(store)(input(), OPERATOR);
    expect(out.commandIds).toEqual([]);
  });
});

describe("answer_interjection: answering twice", () => {
  it("refuses a second answer as interjection_answered and queues no second command (negative)", async () => {
    const store = new MemoryStore([question()]);
    const handler = handlerFor(store);
    await handler(input(), OPERATOR);
    await expect(
      handler(input({ answer: "Cut it from release." }), OPERATOR),
    ).rejects.toSatisfy(conflict("interjection_answered"));
    expect(store.queued).toHaveLength(1);
    expect(store.questions[0]?.answer).toBe("Cut it from main.");
  });
});

describe("answer_interjection: expiry", () => {
  it("refuses a question past its expiry as interjection_expired and writes nothing (negative)", async () => {
    const store = new MemoryStore([question()]);
    const late = new Date(EXPIRES.getTime() + 1_000);
    await expect(handlerFor(store, late)(input(), OPERATOR)).rejects.toSatisfy(
      conflict("interjection_expired"),
    );
    expect(store.questions[0]?.answeredAt).toBeNull();
    expect(store.queued).toEqual([]);
  });

  it("refuses at the exact expiry instant: the run has stopped waiting", async () => {
    const store = new MemoryStore([question()]);
    await expect(
      handlerFor(store, EXPIRES)(input(), OPERATOR),
    ).rejects.toSatisfy(conflict("interjection_expired"));
  });

  it("answers an unknown id, or one in another workspace, as interjection_expired (negative)", async () => {
    const store = new MemoryStore([
      question({ workspaceId: crypto.randomUUID() }),
    ]);
    await expect(handlerFor(store)(input(), OPERATOR)).rejects.toSatisfy(
      conflict("interjection_expired"),
    );
    await expect(
      handlerFor(new MemoryStore([]))(input(), OPERATOR),
    ).rejects.toSatisfy(conflict("interjection_expired"));
  });

  it("answers interjection_expired when the guarded write finds the question closed", async () => {
    const store = new MemoryStore([question()]);
    store.answer = async () => false;
    await expect(handlerFor(store)(input(), OPERATOR)).rejects.toSatisfy(
      conflict("interjection_expired"),
    );
    expect(store.queued).toEqual([]);
  });
});

describe("answer_interjection: the role gate", () => {
  const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";

  it("admits an org Admin and a workspace Owner", async () => {
    tenant("Admin");
    await expect(
      handlerFor(new MemoryStore([question()]))(input(), OPERATOR),
    ).resolves.toMatchObject({ commandIds: ["tcm_1"] });
    tenant("Member", "Owner");
    await expect(
      handlerFor(new MemoryStore([question()]))(input(), OPERATOR),
    ).resolves.toMatchObject({ commandIds: ["tcm_1"] });
  });

  it("refuses a workspace Viewer, an org Member with no workspace role, and a call with no user (negative)", async () => {
    const store = new MemoryStore([question()]);
    tenant("Member", "Viewer");
    await expect(handlerFor(store)(input(), OPERATOR)).rejects.toSatisfy(
      forbidden,
    );
    tenant("Member");
    await expect(handlerFor(store)(input(), OPERATOR)).rejects.toSatisfy(
      forbidden,
    );
    await expect(
      handlerFor(store)(input(), { ...OPERATOR, userId: null }),
    ).rejects.toSatisfy(forbidden);
    expect(store.questions[0]?.answeredAt).toBeNull();
    expect(store.queued).toEqual([]);
  });
});

describe("the Postgres store", () => {
  /** A transaction that records each WHERE, the lock and the update's values. */
  function recording(rows: unknown[]) {
    const seen: {
      where: string[];
      params: unknown[][];
      locked: string | null;
      set: Record<string, unknown> | null;
    } = { where: [], params: [], locked: null, set: null };
    const record = (cond: SQL) => {
      const q = dialect.sqlToQuery(cond);
      seen.where.push(q.sql);
      seen.params.push(q.params);
    };
    const select = {
      from: () => select,
      where: (cond: SQL) => {
        record(cond);
        return select;
      },
      limit: () => select,
      for: (mode: string) => {
        seen.locked = mode;
        return Promise.resolve(rows);
      },
    };
    const update = {
      set: (values: Record<string, unknown>) => {
        seen.set = values;
        return update;
      },
      where: (cond: SQL) => {
        record(cond);
        return update;
      },
      returning: () => Promise.resolve(rows),
    };
    return {
      seen,
      tx: { select: () => select, update: () => update } as never,
    };
  }

  it("locks the question by public id inside the caller's org and workspace, whatever its state", async () => {
    const { postgresInterjectionAnswerStore } = await import(
      "./agent.interjection.answer"
    );
    const { seen, tx } = recording([question()]);
    const found = await postgresInterjectionAnswerStore(tx).lock(
      { orgId: ORG, workspaceId: WORKSPACE },
      "INJ_0123456789ABCDEFGHJKMN",
    );
    expect(found?.publicId).toBe("inj_0123456789abcdefghjkmn");
    expect(seen.locked).toBe("update");
    expect(seen.where[0]).toMatch(/"public_id" = \$/);
    expect(seen.where[0]).toMatch(/"org_id" = \$/);
    expect(seen.where[0]).toMatch(/"workspace_id" = \$/);
    // No open predicate here: the handler reads the state to name the refusal.
    expect(seen.where[0]).not.toMatch(/answered_at|now\(\)/);
    expect(seen.params[0]).toEqual(
      expect.arrayContaining(["inj_0123456789abcdefghjkmn", ORG, WORKSPACE]),
    );
  });

  it("matches a uuid on the row id", async () => {
    const { postgresInterjectionAnswerStore } = await import(
      "./agent.interjection.answer"
    );
    const { seen, tx } = recording([]);
    const found = await postgresInterjectionAnswerStore(tx).lock(
      { orgId: ORG, workspaceId: WORKSPACE },
      "0199a000-0000-7000-8000-000000000001",
    );
    expect(found).toBeNull();
    expect(seen.where[0]).toMatch(/"interjections"\."id" = \$/);
  });

  it("writes the answer only while the question is still open", async () => {
    const { postgresInterjectionAnswerStore } = await import(
      "./agent.interjection.answer"
    );
    const { seen, tx } = recording([{ id: "x" }]);
    const store = postgresInterjectionAnswerStore(tx);
    const args = {
      scope: { orgId: ORG, workspaceId: WORKSPACE },
      id: "0199a000-0000-7000-8000-000000000001",
      answer: "yes",
      userId: USER,
      now: NOW,
    };
    await expect(store.answer(args)).resolves.toBe(true);
    expect(seen.where[0]).toMatch(/"answered_at" is null/);
    expect(seen.where[0]).toMatch(/"expires_at" > now\(\)/);
    expect(seen.set).toMatchObject({
      answeredAt: NOW,
      answer: "yes",
      answeredByUserId: USER,
    });
    const closed = recording([]);
    await expect(
      postgresInterjectionAnswerStore(closed.tx).answer(args),
    ).resolves.toBe(false);
  });
});

describe("answerCommand", () => {
  const base = {
    scope: { orgId: ORG, workspaceId: WORKSPACE },
    interjectionId: "inj_0123456789abcdefghjkmn",
    answer: "yes",
    userId: USER,
    now: NOW,
    expiresAt: EXPIRES,
  };

  it("carries the answer at the next prompt when the host has no step carrier", () => {
    expect(answerCommand({ ...base, session: session() })).toMatchObject({
      requestedMode: "next_step",
      deliveryMode: "turn_boundary",
      degradedReason: "no_step_carrier",
    });
  });

  it("is null for a sealed run and for a harness that reads text only at session start", () => {
    expect(
      answerCommand({ ...base, session: session({ outcome: "completed" }) }),
    ).toBeNull();
    expect(
      answerCommand({ ...base, session: session({ runtime: "stella" }) }),
    ).toBeNull();
  });
});
