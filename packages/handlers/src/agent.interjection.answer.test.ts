// answer_interjection (#3839, #3941): a free-text answer, the link and create
// paths, the wrong shape, answering twice, expiry, the run the answer
// reaches, the receipt and its audit event, and the role gate for each kind,
// against an in-memory store that keeps the InterjectionAnswerStore contract.
// The role gate runs against a faked tenant transaction, as dispatch_command's
// tests fake it. The nested link_repository and create_workspace calls are
// fakes: they are the kernel's in production.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { type CapabilityContext, isHandlerError } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { agentInterjectionAnswer } from "@oxagen/oxagen/contracts/agent.interjection.answer";
import type { RepositoryLinkOutput } from "@oxagen/oxagen/contracts/repository.link";
import { schema } from "@oxagen/database";
import { type InterjectBody, interjectBodySchema } from "@oxagen/recorder";

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
  type AnswerInterjectionDeps,
  answerCommand,
  assertAnswerShape,
  createAnswerInterjectionHandler,
  type InterjectionAnswerStore,
  type InterjectionAuditEvent,
  INTERJECTION_LINK_LISTED_TEXT,
  INTERJECTION_LINK_TEXT,
  INTERJECTION_RELEASE_TTL_MS,
  type InterjectionPathCalls,
  type LockedInterjection,
  mintReceiptId,
} from "./agent.interjection.answer";
import type {
  CommandRowInput,
  RecipientSession,
} from "./tacho.command.dispatch";

const ORG = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const USER = "00000000-0000-4000-8000-0000000000aa";
const USER_PUBLIC_ID = "usr_0123456789abcdefghjkmn";
const NOW = new Date("2026-09-25T09:10:00.000Z");
const EXPIRES = new Date("2026-09-25T09:30:00.000Z");
const KEY = "01K6Z000000000000000000000";
const DIGEST = `sha256:${"e".repeat(64)}`;

const OPERATOR: CapabilityContext = {
  orgId: ORG,
  workspaceId: WORKSPACE,
  userId: USER,
  apiKeyId: null,
  requestId: "req_1",
  surface: "api",
  messageId: null,
};

/** The control.interject body a host seals, as the ingest copied it onto the row. */
const BODY: InterjectBody = interjectBodySchema.parse({
  interjection_key: KEY,
  reason: "repo_unknown",
  question: "Link this repository to core, or create a workspace for it?",
  remote_digest: DIGEST,
  timeout_ms: 1_800_000,
  expires_at: "2026-09-25T09:30:00.000Z",
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
    kind: "question",
    body: null,
    repository: null,
    path: null,
    receiptId: null,
    orgId: ORG,
    workspaceId: WORKSPACE,
    answer: null,
    answeredBy: null,
    ...over,
  };
}

/** A host's repository question, its repository already resolved. */
function repoQuestion(over: Partial<Question> = {}): Question {
  return question({
    kind: "repo_unknown",
    body: BODY,
    repository: "acme/api",
    ...over,
  });
}

class MemoryStore implements InterjectionAnswerStore {
  queued: CommandRowInput[] = [];
  audits: InterjectionAuditEvent[] = [];
  links: { bindingId: string; fullName: string }[] = [];
  /** The workspace row's slug; the question's body names "core". */
  slug: string | null = "core";
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
    if (q === undefined) return null;
    return {
      id: q.id,
      publicId: q.publicId,
      runPublicId: q.runPublicId,
      answeredAt: q.answeredAt,
      expiresAt: q.expiresAt,
      kind: q.kind,
      body: q.body,
      repository: q.repository,
      path: q.path,
      receiptId: q.receiptId,
    };
  }
  async answer(args: {
    id: string;
    answer: string;
    path: LockedInterjection["path"];
    repository: string | null;
    receiptId: string;
    userId: string | null;
    now: Date;
  }) {
    const q = this.questions.find((x) => x.id === args.id);
    if (!q || q.answeredAt !== null || q.expiresAt <= args.now) return false;
    q.answeredAt = args.now;
    q.answer = args.answer;
    q.answeredBy = args.userId;
    q.path = args.path;
    q.receiptId = args.receiptId;
    if (args.repository !== null) q.repository = args.repository;
    return true;
  }
  async session(_scope: unknown, publicId: string) {
    return this.sessions.find((s) => s.publicId === publicId) ?? null;
  }
  async queue(row: CommandRowInput) {
    this.queued.push(row);
    return { publicId: `tcm_${this.queued.length}` };
  }
  async userPublicId(userId: string): Promise<string | null> {
    return userId === USER ? USER_PUBLIC_ID : null;
  }
  async workspaceSlug(): Promise<string | null> {
    return this.slug;
  }
  async linkedBinding(_scope: unknown, fullName: string) {
    return this.links.find((l) => l.fullName === fullName) ?? null;
  }
  async audit(event: InterjectionAuditEvent) {
    this.audits.push(event);
  }
}

/** The binding a repository linked already carries. */
const BINDING_ID = "rpb_0123456789abcdef012345";

const STEERING_PR = {
  number: 42,
  url: "https://github.com/acme/steering/pull/42",
  reused: false,
};

/** link_repository's answer: it opened a steering PR, and bound nothing. */
const LINKED: RepositoryLinkOutput = {
  fullName: "acme/api",
  defaultRef: "main",
  status: "proposed",
  steeringPullRequest: STEERING_PR,
};

/** The row's answer when the link opened the steering PR. */
const PROPOSED_ANSWER = (slug: string) =>
  `Opened steering PR #42 to link acme/api to the workspace ${slug}: ${STEERING_PR.url}. Merge the steering PR to finish linking.`;

const CREATED = {
  publicId: "ws_0123456789abcdefghjkmn",
  name: "API",
  slug: "api",
  orgSlug: "acme",
  createdAt: NOW.toISOString(),
  steering_repo: { status: "provisioning" as const },
};

function fakePaths() {
  return {
    link: vi.fn<InterjectionPathCalls["link"]>(async () => LINKED),
    create: vi.fn<InterjectionPathCalls["create"]>(async () => CREATED),
  };
}

function handlerFor(
  store: MemoryStore,
  opts: {
    now?: Date;
    paths?: InterjectionPathCalls;
    resolve?: (scope: unknown, body: InterjectBody) => Promise<string | null>;
    createdWorkspace?: AnswerInterjectionDeps["createdWorkspace"];
  } = {},
) {
  let receipts = 0;
  return createAnswerInterjectionHandler({
    withStore: (fn) => fn(store),
    now: () => opts.now ?? NOW,
    mintReceipt: () => `rcp_test${++receipts}`,
    paths: opts.paths ?? fakePaths(),
    createdWorkspace: opts.createdWorkspace ?? (async () => null),
    resolveRepository: opts.resolve ?? (async () => null),
  });
}

const input = (over: Record<string, unknown> = {}) =>
  agentInterjectionAnswer.input.parse({
    interjectionId: "inj_0123456789abcdefghjkmn",
    answer: "Cut it from main.",
    ...over,
  });

/** A path answer: no `answer` key at all. */
const pathInput = (over: Record<string, unknown> = {}) =>
  agentInterjectionAnswer.input.parse({
    interjectionId: "inj_0123456789abcdefghjkmn",
    path: "link",
    ...over,
  });

const conflict = (reason: string) => (e: unknown) =>
  isHandlerError(e) && e.code === "conflict" && e.reason === reason;
const forbidden = (e: unknown) => isHandlerError(e) && e.code === "forbidden";

beforeEach(() => {
  vi.clearAllMocks();
  tenant("Member", "Member");
});

describe("answer_interjection: answering", () => {
  it("records the answer, who gave it, when and its receipt, and queues it to the wrapped run as a message", async () => {
    const store = new MemoryStore([question()]);
    const out = await handlerFor(store)(input(), OPERATOR);
    expect(agentInterjectionAnswer.output.parse(out)).toEqual({
      interjectionId: "inj_0123456789abcdefghjkmn",
      runId: "tse_0123456789abcdefghjkmn",
      answeredAt: NOW.toISOString(),
      commandIds: ["tcm_1"],
      receiptId: "rcp_test1",
      path: null,
      repository: null,
      workspace: null,
    });
    expect(store.questions[0]).toMatchObject({
      answeredAt: NOW,
      answer: "Cut it from main.",
      answeredBy: USER,
      receiptId: "rcp_test1",
      path: null,
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
    // A free-text answer releases no host hold.
    expect(command?.payload).not.toHaveProperty("interjection");
  });

  it("writes one agent.interjection_answered event carrying the receipt and the command", async () => {
    const store = new MemoryStore([question()]);
    await handlerFor(store)(input(), OPERATOR);
    expect(store.audits).toEqual([
      expect.objectContaining({
        eventType: "agent.interjection_answered",
        actorUserId: USER,
        orgId: ORG,
        workspaceId: WORKSPACE,
        capability: "answer_interjection",
        outcome: "success",
        requestId: "req_1",
        detail: {
          interjectionId: "inj_0123456789abcdefghjkmn",
          runId: "tse_0123456789abcdefghjkmn",
          kind: "question",
          path: null,
          source: "person",
          receiptId: "rcp_test1",
          commandIds: ["tcm_1"],
        },
      }),
    ]);
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
    expect(store.audits).toHaveLength(1);
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

describe("answer_interjection: the link path", () => {
  beforeEach(() => tenant("Admin"));

  it("opens a steering PR for the repository, records the answer with its path and receipt, and releases the host's hold", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    const out = await handlerFor(store, { paths })(pathInput(), OPERATOR);
    expect(paths.link).toHaveBeenCalledWith(
      { provider: "github", owner: "acme", name: "api" },
      expect.objectContaining({ orgId: ORG, workspaceId: WORKSPACE }),
    );
    expect(paths.create).not.toHaveBeenCalled();
    expect(agentInterjectionAnswer.output.parse(out)).toEqual({
      interjectionId: "inj_0123456789abcdefghjkmn",
      runId: "tse_0123456789abcdefghjkmn",
      answeredAt: NOW.toISOString(),
      commandIds: ["tcm_1"],
      receiptId: "rcp_test1",
      path: "link",
      repository: {
        fullName: "acme/api",
        bindingId: null,
        steeringPullRequest: STEERING_PR,
      },
      workspace: null,
    });
    expect(store.questions[0]).toMatchObject({
      path: "link",
      receiptId: "rcp_test1",
      answeredBy: USER,
      answer: PROPOSED_ANSWER("core"),
    });
    expect(store.queued[0]?.payload).toMatchObject({
      interjection_id: "inj_0123456789abcdefghjkmn",
      interjection: {
        key: KEY,
        path: "link",
        source: "person",
        receipt_id: "rcp_test1",
        answered_by: USER_PUBLIC_ID,
        workspace_slug: "core",
      },
    });
    // Nothing is bound until the steering PR merges, so the release names no
    // binding and the host seals no `repo.bound`.
    expect(store.queued[0]?.payload["interjection"]).not.toHaveProperty(
      "binding_id",
    );
    expect(store.queued[0]?.payload["interjection"]).not.toHaveProperty(
      "workspace_id",
    );
    // The host holds until its next prompt past its own deadline, so the
    // release outlives the question.
    expect(store.queued[0]?.expiresAt).toEqual(
      new Date(NOW.getTime() + INTERJECTION_RELEASE_TTL_MS),
    );
    expect(store.audits[0]?.detail).toEqual({
      interjectionId: "inj_0123456789abcdefghjkmn",
      runId: "tse_0123456789abcdefghjkmn",
      kind: "repo_unknown",
      path: "link",
      source: "person",
      receiptId: "rcp_test1",
      steeringPullRequest: STEERING_PR.url,
      commandIds: ["tcm_1"],
    });
  });

  it("names the workspace's current slug when it was renamed after the question was raised", async () => {
    const store = new MemoryStore([repoQuestion()]);
    store.slug = "core-platform";
    await handlerFor(store)(pathInput(), OPERATOR);
    expect(store.questions[0]).toMatchObject({
      answer: PROPOSED_ANSWER("core-platform"),
    });
    expect(store.queued[0]?.payload).toMatchObject({
      text: "A person opened steering PR #42 to link this repository to the workspace core-platform. The link takes effect when the steering PR merges. The session goes on under that workspace.",
      interjection: { path: "link", workspace_slug: "core-platform" },
    });
  });

  it("admits a workspace Owner", async () => {
    tenant("Member", "Owner");
    await expect(
      handlerFor(new MemoryStore([repoQuestion()]))(pathInput(), OPERATOR),
    ).resolves.toMatchObject({ path: "link" });
  });

  it("resolves the repository from the frame's digest when the row has none, and records it", async () => {
    const store = new MemoryStore([repoQuestion({ repository: null })]);
    const resolve = vi.fn(async () => "acme/api");
    await handlerFor(store, { resolve })(pathInput(), OPERATOR);
    expect(resolve).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WORKSPACE },
      BODY,
    );
    expect(store.questions[0]?.repository).toBe("acme/api");
  });

  it("refuses a repository nobody could resolve, before linking anything (negative)", async () => {
    const store = new MemoryStore([repoQuestion({ repository: null })]);
    const paths = fakePaths();
    await expect(
      handlerFor(store, { paths })(pathInput(), OPERATOR),
    ).rejects.toSatisfy(conflict("interjection_repository_unresolved"));
    expect(paths.link).not.toHaveBeenCalled();
    expect(store.questions[0]?.answeredAt).toBeNull();
  });

  it("answers with the existing binding when the repository is linked already", async () => {
    const store = new MemoryStore([repoQuestion()]);
    store.links.push({ bindingId: BINDING_ID, fullName: "acme/api" });
    const paths = fakePaths();
    paths.link.mockRejectedValueOnce(
      new HandlerError({
        code: "conflict",
        reason: "repository_already_linked",
        message: "acme/api is already linked to this workspace",
      }),
    );
    const out = await handlerFor(store, { paths })(pathInput(), OPERATOR);
    expect(agentInterjectionAnswer.output.parse(out).repository).toEqual({
      bindingId: BINDING_ID,
      fullName: "acme/api",
      steeringPullRequest: null,
    });
    expect(store.questions[0]).toMatchObject({
      path: "link",
      answer: "acme/api is linked to the workspace core already.",
    });
    expect(store.queued[0]?.payload).toMatchObject({
      text: INTERJECTION_LINK_TEXT("core"),
      interjection: { path: "link", binding_id: BINDING_ID },
    });
    expect(store.audits[0]?.detail).toMatchObject({ bindingId: BINDING_ID });
    expect(store.audits[0]?.detail).not.toHaveProperty("steeringPullRequest");
  });

  it("answers a repository the steering record lists already with no steering PR and no binding", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    paths.link.mockResolvedValueOnce({
      ...LINKED,
      status: "listed",
      steeringPullRequest: null,
    });
    const out = await handlerFor(store, { paths })(pathInput(), OPERATOR);
    expect(agentInterjectionAnswer.output.parse(out).repository).toEqual({
      fullName: "acme/api",
      bindingId: null,
      steeringPullRequest: null,
    });
    expect(store.questions[0]).toMatchObject({
      answer:
        "The steering record of the workspace core already lists acme/api. The next steering sync links it.",
    });
    expect(store.queued[0]?.payload).toMatchObject({
      text: INTERJECTION_LINK_LISTED_TEXT("core"),
    });
    expect(store.queued[0]?.payload["interjection"]).not.toHaveProperty(
      "binding_id",
    );
    expect(store.audits[0]?.detail).not.toHaveProperty("bindingId");
    expect(store.audits[0]?.detail).not.toHaveProperty("steeringPullRequest");
  });

  it("answers a retried link with the steering PR it found open", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    const reused = { ...STEERING_PR, reused: true };
    paths.link.mockResolvedValueOnce({
      ...LINKED,
      steeringPullRequest: reused,
    });
    const out = await handlerFor(store, { paths })(pathInput(), OPERATOR);
    expect(out.repository?.steeringPullRequest).toEqual(reused);
    expect(store.questions[0]?.answer).toBe(PROPOSED_ANSWER("core"));
  });

  it("refuses when the link says linked but the store finds no binding (negative)", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    paths.link.mockRejectedValueOnce(
      new HandlerError({
        code: "conflict",
        reason: "repository_already_linked",
        message: "acme/api is already linked to this workspace",
      }),
    );
    await expect(
      handlerFor(store, { paths })(pathInput(), OPERATOR),
    ).rejects.toSatisfy(conflict("repository_already_linked"));
    expect(store.questions[0]?.answeredAt).toBeNull();
    expect(store.queued).toEqual([]);
  });

  it("passes any other link refusal through and records nothing (negative)", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    paths.link.mockRejectedValueOnce(
      new HandlerError({ code: "conflict", reason: "workspace_toml_unreadable" }),
    );
    await expect(
      handlerFor(store, { paths })(pathInput(), OPERATOR),
    ).rejects.toSatisfy(conflict("workspace_toml_unreadable"));
    expect(store.questions[0]?.answeredAt).toBeNull();
    expect(store.queued).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it("leaves off a release the host's schema would refuse, and still records the answer (negative)", async () => {
    const store = new MemoryStore([repoQuestion()]);
    // A binding id past the host's 64-character bound.
    store.links.push({
      bindingId: `rpb_${"0".repeat(80)}`,
      fullName: "acme/api",
    });
    const paths = fakePaths();
    paths.link.mockRejectedValueOnce(
      new HandlerError({
        code: "conflict",
        reason: "repository_already_linked",
        message: "acme/api is already linked to this workspace",
      }),
    );
    const out = await handlerFor(store, { paths })(pathInput(), OPERATOR);
    expect(out.path).toBe("link");
    expect(store.questions[0]?.path).toBe("link");
    expect(store.queued[0]?.payload).not.toHaveProperty("interjection");
  });

  it("names the person by a lowercase usr_ id, which the host's schema requires", async () => {
    const store = new MemoryStore([repoQuestion()]);
    store.userPublicId = async () => "USR_0123456789ABCDEFGHJKMN";
    await handlerFor(store)(pathInput(), OPERATOR);
    expect(store.queued[0]?.payload["interjection"]).toMatchObject({
      answered_by: USER_PUBLIC_ID,
    });
  });

  it("releases the hold of a harness that reads text only at session start: the host applies it", async () => {
    const store = new MemoryStore(
      [repoQuestion()],
      [session({ runtime: "stella" })],
    );
    const out = await handlerFor(store)(pathInput(), OPERATOR);
    expect(out.commandIds).toEqual(["tcm_1"]);
  });
});

describe("answer_interjection: the create path", () => {
  beforeEach(() => tenant("Admin"));

  // Since lane S1 (#4450) create_workspace binds no repository, so the
  // create path sends no mainRepo and its answer names no binding.
  it("creates the workspace without binding the repository, and names the workspace on the answer and the release", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    const out = await handlerFor(store, { paths })(
      pathInput({ path: "create", create: { name: "API", slug: "api" } }),
      OPERATOR,
    );
    expect(paths.create).toHaveBeenCalledWith(
      { name: "API", slug: "api" },
      expect.objectContaining({ orgId: ORG, workspaceId: WORKSPACE }),
    );
    expect(paths.link).not.toHaveBeenCalled();
    expect(agentInterjectionAnswer.output.parse(out)).toMatchObject({
      path: "create",
      receiptId: "rcp_test1",
      repository: null,
      workspace: { publicId: CREATED.publicId, slug: "api" },
    });
    expect(store.questions[0]).toMatchObject({
      path: "create",
      answer:
        "Created the workspace api for acme/api, with skills off. The repository is not linked to it yet.",
    });
    expect(store.queued[0]?.payload).toMatchObject({
      text: "A person created the workspace api for this repository. The repository is not linked to it yet. Its skills are off, so the session goes on without skills.",
      interjection: {
        key: KEY,
        path: "create",
        source: "person",
        workspace_id: CREATED.publicId,
        workspace_slug: "api",
      },
    });
    expect(store.queued[0]?.payload["interjection"]).not.toHaveProperty(
      "binding_id",
    );
    expect(store.audits[0]?.detail).toMatchObject({
      path: "create",
      workspaceId: CREATED.publicId,
    });
    expect(store.audits[0]?.detail).not.toHaveProperty("bindingId");
  });

  it("takes the workspace an earlier try made when a retry finds its slug taken", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    paths.create.mockRejectedValueOnce(
      new HandlerError({
        code: "conflict",
        reason: "slug_taken",
        message: "the slug api is taken in this organization",
      }),
    );
    const createdWorkspace = vi.fn<AnswerInterjectionDeps["createdWorkspace"]>(
      async () => ({ publicId: CREATED.publicId, slug: "api" }),
    );
    const out = await handlerFor(store, { paths, createdWorkspace })(
      pathInput({ path: "create", create: { name: "API", slug: "api" } }),
      OPERATOR,
    );
    // The claim is the workspace this person made under the slug after the
    // question was raised.
    expect(createdWorkspace).toHaveBeenCalledWith(
      { orgId: ORG, workspaceId: WORKSPACE },
      {
        interjectionRowId: store.questions[0]?.id,
        slug: "api",
        createdById: USER,
      },
    );
    expect(out).toMatchObject({
      path: "create",
      repository: null,
      workspace: { publicId: CREATED.publicId, slug: "api" },
    });
    expect(store.questions[0]).toMatchObject({
      path: "create",
      answer:
        "Created the workspace api for acme/api, with skills off. The repository is not linked to it yet.",
    });
    expect(store.queued[0]?.payload).toMatchObject({
      interjection: {
        path: "create",
        workspace_id: CREATED.publicId,
        workspace_slug: "api",
      },
    });
  });

  it("passes slug_taken through when no workspace from this question holds the slug, and records nothing (negative)", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    paths.create.mockRejectedValueOnce(
      new HandlerError({ code: "conflict", reason: "slug_taken" }),
    );
    const createdWorkspace = vi.fn<AnswerInterjectionDeps["createdWorkspace"]>(
      async () => null,
    );
    await expect(
      handlerFor(store, { paths, createdWorkspace })(
        pathInput({ path: "create", create: { name: "API", slug: "api" } }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(conflict("slug_taken"));
    expect(createdWorkspace).toHaveBeenCalledTimes(1);
    expect(store.questions[0]?.answeredAt).toBeNull();
    expect(store.queued).toEqual([]);
    expect(store.audits).toEqual([]);
  });

  it("passes any other create refusal through without looking for a workspace (negative)", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    paths.create.mockRejectedValueOnce(
      new HandlerError({ code: "not_found", reason: "org_not_found" }),
    );
    const createdWorkspace = vi.fn<AnswerInterjectionDeps["createdWorkspace"]>(
      async () => null,
    );
    await expect(
      handlerFor(store, { paths, createdWorkspace })(
        pathInput({ path: "create", create: { name: "API", slug: "api" } }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(
      (e: unknown) => isHandlerError(e) && e.reason === "org_not_found",
    );
    expect(createdWorkspace).not.toHaveBeenCalled();
    expect(store.questions[0]?.answeredAt).toBeNull();
  });
});

describe("answer_interjection: the role gate for a path", () => {
  it("refuses a workspace Member on link and on create, before any call or write (negative)", async () => {
    tenant("Member", "Member");
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    await expect(
      handlerFor(store, { paths })(pathInput(), OPERATOR),
    ).rejects.toSatisfy(forbidden);
    await expect(
      handlerFor(store, { paths })(
        pathInput({ path: "create", create: { name: "API", slug: "api" } }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(forbidden);
    expect(paths.link).not.toHaveBeenCalled();
    expect(paths.create).not.toHaveBeenCalled();
    expect(store.questions[0]?.answeredAt).toBeNull();
    expect(store.audits).toEqual([]);
  });

  it("still lets a workspace Member answer a free-text question", async () => {
    tenant("Member", "Member");
    await expect(
      handlerFor(new MemoryStore([question()]))(input(), OPERATOR),
    ).resolves.toMatchObject({ path: null });
  });
});

describe("answer_interjection: the answer's shape", () => {
  beforeEach(() => tenant("Admin"));

  it("refuses free text on a repository question and a path on a free-text one (negative)", async () => {
    const repo = new MemoryStore([repoQuestion()]);
    await expect(handlerFor(repo)(input(), OPERATOR)).rejects.toSatisfy(
      conflict("interjection_answer_shape"),
    );
    const text = new MemoryStore([question()]);
    await expect(handlerFor(text)(pathInput(), OPERATOR)).rejects.toSatisfy(
      conflict("interjection_answer_shape"),
    );
    expect(repo.questions[0]?.answeredAt).toBeNull();
    expect(text.questions[0]?.answeredAt).toBeNull();
  });

  it("refuses create without its workspace, and link with one (negative)", async () => {
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    await expect(
      handlerFor(store, { paths })(pathInput({ path: "create" }), OPERATOR),
    ).rejects.toSatisfy(conflict("interjection_answer_shape"));
    await expect(
      handlerFor(store, { paths })(
        pathInput({ create: { name: "API", slug: "api" } }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(conflict("interjection_answer_shape"));
    expect(paths.create).not.toHaveBeenCalled();
    expect(paths.link).not.toHaveBeenCalled();
  });

  it("names each combination", () => {
    const ok = (kind: "question" | "repo_unknown", v: object) =>
      expect(() => assertAnswerShape(kind, v)).not.toThrow();
    const bad = (kind: "question" | "repo_unknown", v: object) =>
      expect(() => assertAnswerShape(kind, v)).toThrow(HandlerError);
    ok("question", { answer: "yes" });
    bad("question", {});
    bad("question", { answer: "yes", path: "link" });
    bad("question", { answer: "yes", create: { name: "a", slug: "a" } });
    ok("repo_unknown", { path: "link" });
    ok("repo_unknown", { path: "create", create: { name: "a", slug: "a" } });
    bad("repo_unknown", {});
    bad("repo_unknown", { answer: "yes", path: "link" });
    bad("repo_unknown", { path: "create" });
    bad("repo_unknown", { path: "link", create: { name: "a", slug: "a" } });
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
    expect(store.audits).toHaveLength(1);
    expect(store.questions[0]?.answer).toBe("Cut it from main.");
  });

  it("refuses a second path answer before linking again (negative)", async () => {
    tenant("Admin");
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    const handler = handlerFor(store, { paths });
    await handler(pathInput(), OPERATOR);
    await expect(
      handler(
        pathInput({ path: "create", create: { name: "API", slug: "api" } }),
        OPERATOR,
      ),
    ).rejects.toSatisfy(conflict("interjection_answered"));
    expect(paths.link).toHaveBeenCalledTimes(1);
    expect(paths.create).not.toHaveBeenCalled();
    expect(store.questions[0]?.receiptId).toBe("rcp_test1");
  });

  it("refuses when another answer landed while the link ran, and keeps the first answer (negative)", async () => {
    tenant("Admin");
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    paths.link.mockImplementationOnce(async () => {
      const row = store.questions[0];
      if (row) {
        row.answeredAt = NOW;
        row.answer = "someone else";
      }
      return LINKED;
    });
    await expect(
      handlerFor(store, { paths })(pathInput(), OPERATOR),
    ).rejects.toSatisfy(conflict("interjection_answered"));
    expect(store.questions[0]?.answer).toBe("someone else");
    expect(store.queued).toEqual([]);
  });
});

describe("answer_interjection: expiry", () => {
  it("refuses a question past its expiry as interjection_expired and writes nothing (negative)", async () => {
    const store = new MemoryStore([question()]);
    const late = new Date(EXPIRES.getTime() + 1_000);
    await expect(
      handlerFor(store, { now: late })(input(), OPERATOR),
    ).rejects.toSatisfy(conflict("interjection_expired"));
    expect(store.questions[0]?.answeredAt).toBeNull();
    expect(store.queued).toEqual([]);
  });

  it("refuses a path answer past its expiry before linking (negative)", async () => {
    tenant("Admin");
    const store = new MemoryStore([repoQuestion()]);
    const paths = fakePaths();
    await expect(
      handlerFor(store, { now: EXPIRES, paths })(pathInput(), OPERATOR),
    ).rejects.toSatisfy(conflict("interjection_expired"));
    expect(paths.link).not.toHaveBeenCalled();
  });

  it("refuses at the exact expiry instant: the run has stopped waiting", async () => {
    const store = new MemoryStore([question()]);
    await expect(
      handlerFor(store, { now: EXPIRES })(input(), OPERATOR),
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
    expect(store.audits).toEqual([]);
  });
});

describe("answer_interjection: the role gate", () => {
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

describe("mintReceiptId", () => {
  it("mints a receipt the row's CHECK and the frame's schema accept, a new one each time", () => {
    const a = mintReceiptId();
    expect(a).toMatch(/^rcp_[0-9a-z]+$/);
    expect(mintReceiptId()).not.toBe(a);
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
    expect(found?.kind).toBe("question");
    expect(found?.body).toBeNull();
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

  it("reads the slug of the caller's workspace from its row, inside the caller's org", async () => {
    const { postgresInterjectionAnswerStore } = await import(
      "./agent.interjection.answer"
    );
    const where: SQL[] = [];
    const select = {
      from: () => select,
      where: (cond: SQL) => {
        where.push(cond);
        return select;
      },
      limit: () => Promise.resolve([{ slug: "core-platform" }]),
    };
    const store = postgresInterjectionAnswerStore({
      select: () => select,
    } as never);
    await expect(
      store.workspaceSlug({ orgId: ORG, workspaceId: WORKSPACE }),
    ).resolves.toBe("core-platform");
    expect(where).toHaveLength(1);
    const q = dialect.sqlToQuery(where[0] as SQL);
    expect(q.sql).toMatch(/"id" = \$/);
    expect(q.sql).toMatch(/"org_id" = \$/);
    expect(q.params).toEqual(expect.arrayContaining([WORKSPACE, ORG]));
  });

  it("reads a repository question's body through its schema, and a drifted body as null", async () => {
    const { postgresInterjectionAnswerStore } = await import(
      "./agent.interjection.answer"
    );
    const scope = { orgId: ORG, workspaceId: WORKSPACE };
    const good = recording([
      { ...repoQuestion(), repository: null, path: "link" },
    ]);
    const read = await postgresInterjectionAnswerStore(good.tx).lock(
      scope,
      "inj_0123456789abcdefghjkmn",
    );
    expect(read).toMatchObject({
      kind: "repo_unknown",
      body: BODY,
      path: "link",
    });
    const drifted = recording([
      repoQuestion({ body: { ...BODY, reason: "curious" } as never }),
    ]);
    const bad = await postgresInterjectionAnswerStore(drifted.tx).lock(
      scope,
      "inj_0123456789abcdefghjkmn",
    );
    expect(bad?.body).toBeNull();
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

  it("writes the answer, its path and its receipt only while the question is still open", async () => {
    const { postgresInterjectionAnswerStore } = await import(
      "./agent.interjection.answer"
    );
    const { seen, tx } = recording([{ id: "x" }]);
    const store = postgresInterjectionAnswerStore(tx);
    const args = {
      scope: { orgId: ORG, workspaceId: WORKSPACE },
      id: "0199a000-0000-7000-8000-000000000001",
      answer: "yes",
      path: "link" as const,
      repository: "acme/api",
      receiptId: "rcp_abc",
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
      path: "link",
      receiptId: "rcp_abc",
      repository: "acme/api",
    });
    const closed = recording([]);
    await expect(
      postgresInterjectionAnswerStore(closed.tx).answer({
        ...args,
        repository: null,
      }),
    ).resolves.toBe(false);
    // A repository the row already holds is left alone.
    expect(closed.seen.set).not.toHaveProperty("repository");
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
  const release = {
    key: KEY,
    path: "link" as const,
    source: "person" as const,
    receipt_id: "rcp_abc",
    answered_by: USER_PUBLIC_ID,
    binding_id: BINDING_ID,
    workspace_slug: "core",
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

  it("carries a release to any harness a live host holds, and to none on a host that is gone", () => {
    expect(
      answerCommand({
        ...base,
        session: session({ runtime: "stella" }),
        interjection: release,
      })?.payload,
    ).toMatchObject({ interjection: release });
    expect(
      answerCommand({
        ...base,
        session: session({ outcome: "completed" }),
        interjection: release,
      }),
    ).toBeNull();
  });
});
