// The interjection timeout's two steps (#3941, D8), against an in-memory
// store that keeps the InterjectionTimeoutStore contract: the deny at the
// deadline in each of its three cases, a retried step, and the repository
// step before it. The Postgres store's guards are read back as SQL.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { type InterjectBody, interjectBodySchema } from "@oxagen/tacho";

vi.mock("../logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import type {
  InterjectionAuditEvent,
  LockedInterjection,
} from "../agent.interjection.answer";
import type {
  CommandRowInput,
  RecipientSession,
} from "../tacho.command.dispatch";
import { HOST_TIMEOUT_ANSWER } from "./interjection-frames";
import {
  denyExpiredInterjection,
  INTERJECTION_RELEASE_TTL_MS,
  INTERJECTION_TIMED_OUT_TEXT,
  type InterjectionTimeoutDeps,
  type InterjectionTimeoutStore,
  postgresInterjectionTimeoutStore,
  resolveRaisedInterjectionRepository,
} from "./interjection-timeout";

const ORG = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const RAISED = new Date("2026-09-25T09:00:00.000Z");
const EXPIRES = new Date("2026-09-25T09:30:00.000Z");
const AT_DEADLINE = new Date("2026-09-25T09:30:00.250Z");
const KEY = "01K6Z000000000000000000000";

const REQUEST = {
  orgId: ORG,
  workspaceId: WORKSPACE,
  interjectionId: "inj_0123456789abcdefghjkmn",
  expiresAt: EXPIRES.toISOString(),
};

const BODY: InterjectBody = interjectBodySchema.parse({
  interjection_key: KEY,
  reason: "repo_unknown",
  question: "Link this repository to core, or create a workspace for it?",
  remote_digest: `sha256:${"e".repeat(64)}`,
  timeout_ms: 1_800_000,
  expires_at: EXPIRES.toISOString(),
  on_timeout: "deny",
  paths: [
    {
      path: "link",
      workspace_slug: "core",
      config_version: "skl_v2",
      skills_pinned: 3,
      linked_repositories: 1,
    },
    {
      path: "create",
      proposed_name: "api",
      proposed_slug: "api",
      skills_enabled: false,
    },
  ],
});

type Row = LockedInterjection & {
  answer: string | null;
  answeredBy: string | null;
};

function row(over: Partial<Row> = {}): Row {
  return {
    id: "0199a000-0000-7000-8000-000000000001",
    publicId: "inj_0123456789abcdefghjkmn",
    runPublicId: "tse_0123456789abcdefghjkmn",
    answeredAt: null,
    expiresAt: EXPIRES,
    kind: "repo_unknown",
    body: BODY,
    repository: null,
    path: null,
    receiptId: null,
    answer: null,
    answeredBy: null,
    ...over,
  };
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
      lastSeenAt: new Date(AT_DEADLINE.getTime() - 30_000),
      bundleFeatures: [],
    },
    ...over,
  };
}

class MemoryStore implements InterjectionTimeoutStore {
  queued: CommandRowInput[] = [];
  audits: InterjectionAuditEvent[] = [];
  constructor(
    readonly rows: Row[],
    readonly sessions: RecipientSession[] = [session()],
  ) {}
  private find(id: string) {
    return this.rows.find((r) => r.publicId === id || r.id === id);
  }
  async lock(_scope: unknown, id: string) {
    const r = this.find(id);
    return r === undefined ? null : { ...r };
  }
  async setRepository(_scope: unknown, id: string, repository: string) {
    const r = this.find(id);
    if (r && r.repository === null) r.repository = repository;
  }
  async deny(args: { id: string; receiptId: string; now: Date }) {
    const r = this.find(args.id);
    if (!r || r.answeredAt !== null) return false;
    Object.assign(r, {
      answeredAt: args.now,
      answer: HOST_TIMEOUT_ANSWER,
      answeredBy: null,
      path: "deny",
      receiptId: args.receiptId,
    });
    return true;
  }
  async receipt(args: { id: string; receiptId: string }) {
    const r = this.find(args.id);
    if (!r || r.answeredAt === null || r.path !== "deny" || r.receiptId)
      return false;
    r.receiptId = args.receiptId;
    return true;
  }
  async session(_scope: unknown, publicId: string) {
    return this.sessions.find((s) => s.publicId === publicId) ?? null;
  }
  async queue(command: CommandRowInput) {
    this.queued.push(command);
    return { publicId: `tcm_${this.queued.length}` };
  }
  async audit(event: InterjectionAuditEvent) {
    this.audits.push(event);
  }
}

function depsFor(
  store: MemoryStore,
  opts: {
    now?: Date;
    resolve?: InterjectionTimeoutDeps["resolveRepository"];
  } = {},
): InterjectionTimeoutDeps {
  let receipts = 0;
  return {
    withStore: (_scope, fn) => fn(store),
    now: () => opts.now ?? AT_DEADLINE,
    mintReceipt: () => `rcp_timeout${++receipts}`,
    resolveRepository: opts.resolve ?? (async () => null),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the deny at the deadline", () => {
  it("answers deny with no person and a receipt, releases the host's hold, and tells the agent why", async () => {
    const store = new MemoryStore([row()]);
    const out = await denyExpiredInterjection(REQUEST, depsFor(store));
    expect(out).toEqual({
      outcome: "denied",
      receiptId: "rcp_timeout1",
      commandIds: ["tcm_1"],
    });
    expect(store.rows[0]).toMatchObject({
      answeredAt: AT_DEADLINE,
      answer: HOST_TIMEOUT_ANSWER,
      answeredBy: null,
      path: "deny",
      receiptId: "rcp_timeout1",
    });
    const [command] = store.queued;
    expect(command).toMatchObject({
      command: "message",
      issuedByUserId: null,
      // The question has expired, so the release carries its own window.
      expiresAt: new Date(AT_DEADLINE.getTime() + INTERJECTION_RELEASE_TTL_MS),
      payload: {
        text: INTERJECTION_TIMED_OUT_TEXT,
        interjection_id: "inj_0123456789abcdefghjkmn",
        interjection: {
          key: KEY,
          path: "deny",
          source: "timeout",
          receipt_id: "rcp_timeout1",
          answered_by: null,
        },
      },
    });
    expect(store.audits).toEqual([
      expect.objectContaining({
        eventType: "agent.interjection_answered",
        actorUserId: null,
        orgId: ORG,
        workspaceId: WORKSPACE,
        requestId: "interjection-timeout:inj_0123456789abcdefghjkmn",
        detail: {
          interjectionId: "inj_0123456789abcdefghjkmn",
          runId: "tse_0123456789abcdefghjkmn",
          kind: "repo_unknown",
          path: "deny",
          source: "timeout",
          receiptId: "rcp_timeout1",
          commandIds: ["tcm_1"],
        },
      }),
    ]);
  });

  it("leaves a question a person answered before the deadline untouched (negative)", async () => {
    const answered = row({
      answeredAt: new Date("2026-09-25T09:05:00.000Z"),
      answer: "Linked acme/api to the workspace core.",
      answeredBy: "00000000-0000-4000-8000-0000000000aa",
      path: "link",
      receiptId: "rcp_person",
    });
    const store = new MemoryStore([answered]);
    await expect(
      denyExpiredInterjection(REQUEST, depsFor(store)),
    ).resolves.toEqual({
      outcome: "answered",
      receiptId: "rcp_person",
      commandIds: [],
    });
    expect(store.rows[0]).toMatchObject({ path: "link", receiptId: "rcp_person" });
    expect(store.queued).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it("adds the receipt and the event to a deny the host's own timeout recorded, and queues nothing", async () => {
    const closedByHost = row({
      answeredAt: new Date("2026-09-25T09:30:00.100Z"),
      answer: HOST_TIMEOUT_ANSWER,
      path: "deny",
    });
    const store = new MemoryStore([closedByHost]);
    await expect(
      denyExpiredInterjection(REQUEST, depsFor(store)),
    ).resolves.toEqual({
      outcome: "receipted",
      receiptId: "rcp_timeout1",
      commandIds: [],
    });
    expect(store.rows[0]?.receiptId).toBe("rcp_timeout1");
    // The host already let the loop go; a release would be acked failed.
    expect(store.queued).toEqual([]);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]?.detail).toMatchObject({
      source: "timeout",
      path: "deny",
      commandIds: [],
    });
  });

  it("writes one deny however often the step is retried", async () => {
    const store = new MemoryStore([row()]);
    const deps = depsFor(store);
    await denyExpiredInterjection(REQUEST, deps);
    await expect(denyExpiredInterjection(REQUEST, deps)).resolves.toEqual({
      outcome: "answered",
      receiptId: "rcp_timeout1",
      commandIds: [],
    });
    expect(store.queued).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
  });

  it("does not deny before the deadline (negative)", async () => {
    const store = new MemoryStore([row()]);
    await expect(
      denyExpiredInterjection(
        REQUEST,
        depsFor(store, { now: new Date(EXPIRES.getTime() - 1_000) }),
      ),
    ).resolves.toMatchObject({ outcome: "not_due" });
    expect(store.rows[0]?.answeredAt).toBeNull();
  });

  it("records the deny with no release for a host that is gone", async () => {
    const offline = session({
      host: {
        status: "active",
        lastSeenAt: new Date(AT_DEADLINE.getTime() - 60 * 60_000),
        bundleFeatures: [],
      },
    });
    const store = new MemoryStore([row()], [offline]);
    await expect(
      denyExpiredInterjection(REQUEST, depsFor(store)),
    ).resolves.toMatchObject({ outcome: "denied", commandIds: [] });
    expect(store.rows[0]?.path).toBe("deny");
    expect(store.audits[0]?.detail).toMatchObject({ commandIds: [] });
  });

  it("answers gone for no row, and for a question no host raised (negative)", async () => {
    await expect(
      denyExpiredInterjection(REQUEST, depsFor(new MemoryStore([]))),
    ).resolves.toMatchObject({ outcome: "gone" });
    const store = new MemoryStore([row({ kind: "question", body: null })]);
    await expect(
      denyExpiredInterjection(REQUEST, depsFor(store)),
    ).resolves.toMatchObject({ outcome: "gone" });
    expect(store.rows[0]?.answeredAt).toBeNull();
  });
});

describe("the repository step", () => {
  it("writes the repository the frame's digest names onto the row", async () => {
    const store = new MemoryStore([row()]);
    const resolve = vi.fn(async () => "acme/api");
    await expect(
      resolveRaisedInterjectionRepository(REQUEST, depsFor(store, { resolve })),
    ).resolves.toEqual({ outcome: "resolved", repository: "acme/api" });
    expect(resolve).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WORKSPACE },
      BODY,
    );
    expect(store.rows[0]?.repository).toBe("acme/api");
  });

  it("skips a row that already names its repository, or is answered", async () => {
    const resolve = vi.fn(async () => "acme/other");
    for (const r of [
      row({ repository: "acme/api" }),
      row({ answeredAt: RAISED, answer: "x", path: "deny" }),
    ]) {
      const store = new MemoryStore([r]);
      await expect(
        resolveRaisedInterjectionRepository(
          REQUEST,
          depsFor(store, { resolve }),
        ),
      ).resolves.toMatchObject({ outcome: "skipped" });
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("answers unresolved on a GitHub failure, so the timeout still runs (negative)", async () => {
    const store = new MemoryStore([row()]);
    await expect(
      resolveRaisedInterjectionRepository(
        REQUEST,
        depsFor(store, {
          resolve: () => Promise.reject(new Error("github 502")),
        }),
      ),
    ).resolves.toEqual({ outcome: "unresolved", repository: null });
    expect(store.rows[0]?.repository).toBeNull();
  });

  it("answers unresolved when no repository matches", async () => {
    const store = new MemoryStore([row()]);
    await expect(
      resolveRaisedInterjectionRepository(REQUEST, depsFor(store)),
    ).resolves.toEqual({ outcome: "unresolved", repository: null });
  });
});

describe("the Postgres store", () => {
  const dialect = new PgDialect();
  const scope = { orgId: ORG, workspaceId: WORKSPACE };

  function recording(returned: unknown[]) {
    const seen: { where: string[]; set: Record<string, unknown>[] } = {
      where: [],
      set: [],
    };
    const update = {
      set: (values: Record<string, unknown>) => {
        seen.set.push(values);
        return update;
      },
      where: (cond: SQL) => {
        seen.where.push(dialect.sqlToQuery(cond).sql);
        return Object.assign(Promise.resolve(undefined), {
          returning: () => Promise.resolve(returned),
        });
      },
    };
    return { seen, tx: { update: () => update } as never };
  }

  it("denies only a row nobody answered, with no person", async () => {
    const { seen, tx } = recording([{ id: "x" }]);
    await expect(
      postgresInterjectionTimeoutStore(tx).deny({
        scope,
        id: "x",
        receiptId: "rcp_1",
        now: AT_DEADLINE,
      }),
    ).resolves.toBe(true);
    expect(seen.where[0]).toMatch(/"answered_at" is null/);
    expect(seen.where[0]).toMatch(/"org_id" = \$/);
    expect(seen.where[0]).toMatch(/"workspace_id" = \$/);
    // The timeout owns the deadline: no expiry predicate.
    expect(seen.where[0]).not.toMatch(/now\(\)/);
    expect(seen.set[0]).toMatchObject({
      answeredAt: AT_DEADLINE,
      answer: HOST_TIMEOUT_ANSWER,
      answeredByUserId: null,
      path: "deny",
      receiptId: "rcp_1",
    });
    const closed = recording([]);
    await expect(
      postgresInterjectionTimeoutStore(closed.tx).deny({
        scope,
        id: "x",
        receiptId: "rcp_1",
        now: AT_DEADLINE,
      }),
    ).resolves.toBe(false);
  });

  it("adds a receipt only to a deny that has none", async () => {
    const { seen, tx } = recording([{ id: "x" }]);
    await postgresInterjectionTimeoutStore(tx).receipt({
      scope,
      id: "x",
      receiptId: "rcp_1",
      now: AT_DEADLINE,
    });
    expect(seen.where[0]).toMatch(/"answered_at" is not null/);
    expect(seen.where[0]).toMatch(/"path" = \$/);
    expect(seen.where[0]).toMatch(/"receipt_id" is null/);
    expect(seen.set[0]).toEqual({ receiptId: "rcp_1", updatedAt: AT_DEADLINE });
  });

  it("writes a repository only onto a row that names none", async () => {
    const { seen, tx } = recording([]);
    await postgresInterjectionTimeoutStore(tx).setRepository(
      scope,
      "x",
      "acme/api",
    );
    expect(seen.where[0]).toMatch(/"repository" is null/);
    expect(seen.set[0]).toMatchObject({ repository: "acme/api" });
  });
});
