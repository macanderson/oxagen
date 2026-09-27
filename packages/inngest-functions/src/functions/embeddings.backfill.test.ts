import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Fake graph ───────────────────────────────────────────────────────────────
// The backfill reads and writes through scopedSession(). The fake session
// below answers its Cypher from an in-memory node list, scoped to the
// workspace runInTenantScope last entered, the way the real seam injects
// $orgId and $workspaceId.

interface FakeNode {
  kind: "memory" | "entity";
  orgId: string;
  workspaceId: string;
  id: string;
  embedding: number[] | null;
  embeddingModel?: string;
  lesson?: string;
  entityType?: string;
  displayName?: string | null;
  naturalKey?: string;
  properties?: string;
  connectionId?: string;
  sourceRecordType?: string;
}

interface Scope {
  orgId: string;
  workspaceId: string;
}

type Handler = (ctx: {
  event: { name: string; data: Record<string, unknown> };
  events: unknown[];
  step: FakeStep;
}) => Promise<unknown>;

const mocks = vi.hoisted(() => {
  class EmbeddingUnavailableError extends Error {
    readonly code = "embedding_unavailable" as const;
    constructor(
      message: string,
      readonly statusCode?: number,
      readonly providerMessage?: string,
    ) {
      super(message);
      this.name = "EmbeddingUnavailableError";
    }
  }
  return {
    EmbeddingUnavailableError,
    handlers: new Map<string, unknown>(),
    configs: new Map<string, unknown>(),
    triggers: new Map<string, unknown>(),
    scope: null as { orgId: string; workspaceId: string } | null,
    nodes: new Map<string, unknown>(),
    workspaces: [] as { id: string; orgId: string }[],
    connections: [] as {
      id: string;
      workspaceId: string;
      deliveryConfig: unknown;
    }[],
    unreadableWorkspaces: new Set<string>(),
    embedMany: vi.fn(),
    upsertEmbedding: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock("../create-function", () => ({
  createFunction: (
    config: { id: string },
    trigger: unknown,
    handler: unknown,
  ) => {
    mocks.handlers.set(config.id, handler);
    mocks.configs.set(config.id, config);
    mocks.triggers.set(config.id, trigger);
    return [{ config, trigger }];
  },
}));

vi.mock("../logger", () => ({ logger: mocks.logger }));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (scope: Scope, fn: () => unknown) => {
    const previous = mocks.scope;
    mocks.scope = scope;
    const restore = () => {
      mocks.scope = previous;
    };
    try {
      const out = fn();
      if (out instanceof Promise) return out.finally(restore);
      restore();
      return out;
    } catch (err) {
      restore();
      throw err;
    }
  },
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // Bound once and aliased, so withOrgDb and withTenantDb are one function
  // and neither falls through to the real, scope-checking seam (ADR-086).
  const __dbMock = {
    ...real,
    withSystemDb: (fn: (tx: unknown) => unknown) =>
      fn({
        query: {
          workspaces: {
            findMany: async () =>
              mocks.workspaces.map((w) => ({ id: w.id, orgId: w.orgId })),
          },
        },
      }),
    withTenantDb: (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: () => ({
            where: async () =>
              mocks.connections
                .filter((c) => c.workspaceId === mocks.scope?.workspaceId)
                .map((c) => ({ id: c.id, deliveryConfig: c.deliveryConfig })),
          }),
        }),
      }),
  };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

vi.mock("@oxagen/ai", () => ({
  embedMany: mocks.embedMany,
  embedText: vi.fn(),
  EMBEDDING_MODEL: "voyage-4-large",
  EmbeddingUnavailableError: mocks.EmbeddingUnavailableError,
}));

// The pipeline's own vector write. The fake stores the vector the way its
// Cypher does: on the entity with that publicId in that organisation.
vi.mock("@oxagen/ingestion/mutations", () => ({
  upsertEmbedding: mocks.upsertEmbedding,
}));

/** A count comes back over Bolt as a driver Integer, not a number. */
function driverInt(n: number) {
  return { toNumber: () => n, toString: () => String(n) };
}

function record(map: Record<string, unknown>) {
  return { get: (key: string) => map[key] };
}

function nodesOf(): FakeNode[] {
  return [...mocks.nodes.values()] as FakeNode[];
}

function runCypher(
  scope: Scope,
  cypher: string,
  params: Record<string, unknown>,
) {
  if (mocks.unreadableWorkspaces.has(scope.workspaceId)) {
    throw new Error("graph plane is disabled for this organisation");
  }
  const kind = cypher.includes(":AgentMemory") ? "memory" : "entity";
  const here = nodesOf().filter(
    (n) =>
      n.kind === kind &&
      n.orgId === scope.orgId &&
      n.workspaceId === scope.workspaceId,
  );
  const embeddable = (n: FakeNode) => {
    if (kind === "memory") return Boolean(n.lesson?.trim());
    const allowed = (params.connectionIds as string[]) ?? [];
    const optedOut = (params.optedOutRecordTypes as string[]) ?? [];
    return (
      allowed.includes(n.connectionId ?? "") &&
      !optedOut.includes(`${n.connectionId}:${n.sourceRecordType}`)
    );
  };
  const missing = here.filter((n) => n.embedding === null);

  if (cypher.includes("UNWIND $rows")) {
    let written = 0;
    for (const row of params.rows as {
      id: string;
      lesson: string;
      embedding: number[];
    }[]) {
      const node = here.find((n) => n.id === row.id);
      if (node && node.embedding === null && node.lesson === row.lesson) {
        node.embedding = row.embedding;
        node.embeddingModel = params.model as string;
        written += 1;
      }
    }
    return { records: [record({ written: driverInt(written) })] };
  }
  if (cypher.includes("count(CASE")) {
    return {
      records: [
        record({
          missing: driverInt(missing.filter(embeddable).length),
          excluded: driverInt(missing.filter((n) => !embeddable(n)).length),
        }),
      ],
    };
  }
  if (cypher.includes("IN $ids")) {
    const ids = params.ids as string[];
    return {
      records: missing
        .filter((n) => ids.includes(n.id))
        .filter((n) => kind === "entity" || embeddable(n))
        .map((n) =>
          record(
            kind === "memory"
              ? { id: n.id, lesson: n.lesson }
              : {
                  id: n.id,
                  entityType: n.entityType,
                  displayName: n.displayName ?? null,
                  naturalKey: n.naturalKey ?? null,
                  properties: n.properties ?? null,
                },
          ),
        ),
    };
  }
  if (cypher.includes("LIMIT $limit")) {
    const limit = Number(params.limit as bigint);
    return {
      records: missing
        .filter(embeddable)
        .slice(0, limit)
        .map((n) => record({ id: n.id })),
    };
  }
  throw new Error(`the fake graph does not answer: ${cypher}`);
}

vi.mock("@oxagen/ontology", () => ({
  oversampledLimit: (n: number) => n,
  scopedSession: () => {
    const scope = mocks.scope;
    if (!scope) throw new Error("no tenant scope");
    return {
      run: async (cypher: string, params: Record<string, unknown> = {}) =>
        runCypher(scope, cypher, params),
      close: async () => undefined,
    };
  },
}));

const {
  EMBEDDINGS_BACKFILL_REQUESTED_EVENT,
  EMBED_BATCH_SIZE,
  MAX_BATCHES_PER_RUN,
  MAX_NODES_PER_RUN,
} = await import("./embeddings.backfill");
const { renderEntityText } = await import("@oxagen/ingestion/embed");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** One vector per text, so a test can tell which text a node got. */
function vectorFor(text: string): number[] {
  let sum = 0;
  for (const ch of text) sum += ch.charCodeAt(0);
  return [text.length, sum];
}

/**
 * Inngest's step: each step's result is checkpointed as JSON by name, and a
 * retried run gets the checkpoint back instead of running the step again.
 */
interface FakeStep {
  run: (name: string, fn: () => unknown) => Promise<unknown>;
  sendEvent: ReturnType<typeof vi.fn>;
  waitForEvent: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  names: string[];
  before?: (name: string) => void;
}

function makeStep(): FakeStep {
  const done = new Map<string, unknown>();
  const step: FakeStep = {
    names: [],
    run: async (name, fn) => {
      if (done.has(name)) return done.get(name);
      step.names.push(name);
      step.before?.(name);
      const out: unknown = JSON.parse(JSON.stringify(await fn()));
      done.set(name, out);
      return out;
    },
    sendEvent: vi.fn(async () => undefined),
    waitForEvent: vi.fn(),
    sleep: vi.fn(),
  };
  return step;
}

function handler(id: string): Handler {
  const fn = mocks.handlers.get(id);
  if (!fn) throw new Error(`no function registered as ${id}`);
  return fn as Handler;
}

function runBackfill(step: FakeStep, data: Record<string, unknown> = {}) {
  return handler("embeddings/backfill")({
    event: { name: EMBEDDINGS_BACKFILL_REQUESTED_EVENT, data },
    events: [],
    step,
  });
}

/** A workspace with one connection that allows embedding. */
function workspace(orgId: string, workspaceId: string): void {
  mocks.workspaces.push({ id: workspaceId, orgId });
  mocks.connections.push({
    id: `con-${workspaceId}`,
    workspaceId,
    deliveryConfig: null,
  });
}

function entity(
  orgId: string,
  workspaceId: string,
  id: string,
  overrides: Partial<FakeNode> = {},
): FakeNode {
  const node: FakeNode = {
    kind: "entity",
    orgId,
    workspaceId,
    id,
    embedding: null,
    entityType: "Issue",
    displayName: `Fix ${id}`,
    naturalKey: `github:con-${workspaceId}:${id}`,
    properties: JSON.stringify({ state: "open", number: 7 }),
    connectionId: `con-${workspaceId}`,
    sourceRecordType: "issue",
    ...overrides,
  };
  mocks.nodes.set(`entity:${id}`, node);
  return node;
}

function memory(
  orgId: string,
  workspaceId: string,
  id: string,
  lesson = `Run the migration before ${id}`,
): FakeNode {
  const node: FakeNode = {
    kind: "memory",
    orgId,
    workspaceId,
    id,
    embedding: null,
    lesson,
  };
  mocks.nodes.set(`memory:${id}`, node);
  return node;
}

function summaryLine(): Record<string, unknown> {
  const call =
    mocks.logger.info.mock.calls.find(
      (c) => c[1] === "embeddings.backfill: run complete",
    ) ??
    mocks.logger.warn.mock.calls.find((c) =>
      String(c[1]).startsWith("embeddings.backfill: stopped early"),
    );
  if (!call) throw new Error("the run wrote no summary line");
  return call[0] as Record<string, unknown>;
}

beforeEach(() => {
  mocks.scope = null;
  mocks.nodes.clear();
  mocks.workspaces.length = 0;
  mocks.connections.length = 0;
  mocks.unreadableWorkspaces.clear();
  mocks.logger.info.mockReset();
  mocks.logger.warn.mockReset();
  mocks.embedMany
    .mockReset()
    .mockImplementation(async (texts: string[]) => texts.map(vectorFor));
  mocks.upsertEmbedding
    .mockReset()
    .mockImplementation(
      async (id: string, vector: number[], model: string, orgId: string) => {
        const node = mocks.nodes.get(`entity:${id}`) as FakeNode | undefined;
        if (node && node.orgId === orgId) {
          node.embedding = vector;
          node.embeddingModel = model;
        }
      },
    );
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("embeddings/backfill triggers", () => {
  it("runs one pass at a time on the backfill event", () => {
    expect(mocks.triggers.get("embeddings/backfill")).toEqual({
      event: "embeddings/backfill.requested",
    });
    expect(mocks.configs.get("embeddings/backfill")).toMatchObject({
      concurrency: { limit: 1 },
    });
  });

  it("sends the backfill event every 30 minutes", async () => {
    expect(mocks.triggers.get("embeddings/backfill-schedule")).toEqual({
      cron: "*/30 * * * *",
    });
    const step = makeStep();
    await handler("embeddings/backfill-schedule")({
      event: { name: "", data: {} },
      events: [],
      step,
    });
    expect(step.sendEvent).toHaveBeenCalledWith("request-backfill", {
      name: EMBEDDINGS_BACKFILL_REQUESTED_EVENT,
      data: { source: "schedule" },
    });
  });

  it("names the source of the run in the summary", async () => {
    await runBackfill(makeStep(), { source: "schedule" });
    expect(summaryLine().source).toBe("schedule");
    mocks.logger.info.mockReset();
    await runBackfill(makeStep());
    expect(summaryLine().source).toBe("manual");
  });
});

describe("embeddings/backfill", () => {
  it("embeds each workspace in its own embedMany call, metered to that org and workspace", async () => {
    workspace("org-a", "ws-1");
    workspace("org-a", "ws-2");
    workspace("org-b", "ws-3");
    const m1 = memory("org-a", "ws-1", "m1");
    const e1 = entity("org-a", "ws-1", "e1");
    const e2 = entity("org-a", "ws-2", "e2");
    const m3 = memory("org-b", "ws-3", "m3");

    await runBackfill(makeStep());

    expect(mocks.embedMany).toHaveBeenCalledTimes(3);
    const calls = mocks.embedMany.mock.calls as [
      string[],
      { telemetry: Record<string, unknown>; inputType: string },
    ][];
    const byWorkspace = new Map(
      calls.map(([texts, opts]) => [
        opts.telemetry.workspaceId,
        { texts, opts },
      ]),
    );
    expect(byWorkspace.get("ws-1")?.opts).toEqual({
      telemetry: {
        orgId: "org-a",
        workspaceId: "ws-1",
        surface: "ingestion",
        executionStepId: null,
      },
      inputType: "document",
    });
    expect(byWorkspace.get("ws-1")?.texts).toEqual([
      m1.lesson,
      renderEntityText("Issue", "Fix e1", { state: "open", number: 7 }),
    ]);
    expect(byWorkspace.get("ws-2")?.opts.telemetry.orgId).toBe("org-a");
    expect(byWorkspace.get("ws-3")?.opts.telemetry.orgId).toBe("org-b");
    expect(byWorkspace.get("ws-3")?.texts).toEqual([m3.lesson]);

    // Every node holds the vector of its own text and the model that made it.
    expect(m1.embedding).toEqual(vectorFor(m1.lesson!));
    expect(m1.embeddingModel).toBe("voyage-4-large");
    expect(m3.embeddingModel).toBe("voyage-4-large");
    const e1Text = renderEntityText("Issue", "Fix e1", {
      state: "open",
      number: 7,
    });
    expect(mocks.upsertEmbedding).toHaveBeenCalledWith(
      "e1",
      vectorFor(e1Text),
      "voyage-4-large",
      "org-a",
    );
    expect(e1.embeddingModel).toBe("voyage-4-large");
    expect(e2.embedding).not.toBeNull();

    expect(summaryLine()).toMatchObject({
      model: "voyage-4-large",
      workspaces: 3,
      workspacesFailed: 0,
      missingBefore: 4,
      selected: 4,
      embedded: 4,
      skipped: 0,
      stillMissing: 0,
      stoppedEarly: false,
    });
  });

  it("renders an entity with no display name the way ingestion did", async () => {
    workspace("org-a", "ws-1");
    entity("org-a", "ws-1", "e1", {
      displayName: "github:con-ws-1:e1",
      naturalKey: "github:con-ws-1:e1",
    });

    await runBackfill(makeStep());

    expect(mocks.embedMany.mock.calls[0]?.[0]).toEqual([
      renderEntityText("Issue", undefined, { state: "open", number: 7 }),
    ]);
  });

  it("does no work when nothing is missing", async () => {
    workspace("org-a", "ws-1");
    entity("org-a", "ws-1", "e1", { embedding: [1, 2] });

    await runBackfill(makeStep());

    expect(mocks.embedMany).not.toHaveBeenCalled();
    expect(summaryLine()).toMatchObject({
      missingBefore: 0,
      selected: 0,
      embedded: 0,
      stillMissing: 0,
    });
  });

  it("embeds at most the per-run cap, in batches of the batch size, and reports the rest", async () => {
    workspace("org-a", "ws-1");
    for (let i = 0; i < MAX_NODES_PER_RUN + 50; i += 1) {
      entity("org-a", "ws-1", `e${i}`);
    }

    await runBackfill(makeStep());

    const sizes = (mocks.embedMany.mock.calls as [string[]][]).map(
      ([texts]) => texts.length,
    );
    expect(sizes).toHaveLength(Math.ceil(MAX_NODES_PER_RUN / EMBED_BATCH_SIZE));
    expect(Math.max(...sizes)).toBe(EMBED_BATCH_SIZE);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(MAX_NODES_PER_RUN);
    expect(summaryLine()).toMatchObject({
      missingBefore: MAX_NODES_PER_RUN + 50,
      selected: MAX_NODES_PER_RUN,
      embedded: MAX_NODES_PER_RUN,
      stillMissing: 50,
    });

    // The next run picks up what this one left.
    mocks.logger.info.mockReset();
    mocks.embedMany.mockClear();
    await runBackfill(makeStep());
    expect(summaryLine()).toMatchObject({
      missingBefore: 50,
      embedded: 50,
      stillMissing: 0,
    });
    expect(nodesOf().every((n) => n.embedding !== null)).toBe(true);
  });

  it("plans at most the batch cap in one run", async () => {
    const count = MAX_BATCHES_PER_RUN + 5;
    for (let i = 0; i < count; i += 1) {
      const ws = `ws-${String(i).padStart(3, "0")}`;
      workspace("org-a", ws);
      entity("org-a", ws, `e${i}`);
    }

    const step = makeStep();
    await runBackfill(step);

    expect(mocks.embedMany).toHaveBeenCalledTimes(MAX_BATCHES_PER_RUN);
    expect(step.names.filter((n) => n.startsWith("embed-batch-"))).toHaveLength(
      MAX_BATCHES_PER_RUN,
    );
    expect(summaryLine()).toMatchObject({
      missingBefore: count,
      selected: MAX_BATCHES_PER_RUN,
      stillMissing: 5,
    });
  });

  it("stops at the first EmbeddingUnavailableError and leaves the rest for the next run", async () => {
    workspace("org-a", "ws-1");
    workspace("org-b", "ws-2");
    const e1 = entity("org-a", "ws-1", "e1");
    const m2 = memory("org-b", "ws-2", "m2");
    mocks.embedMany.mockRejectedValueOnce(
      new mocks.EmbeddingUnavailableError(
        "Embeddings are unavailable: Voyage answered 402",
        402,
        "Insufficient credits",
      ),
    );

    const step = makeStep();
    await expect(runBackfill(step)).resolves.toBeDefined();

    expect(mocks.embedMany).toHaveBeenCalledTimes(1);
    expect(step.names).toEqual(["select-missing", "embed-batch-0"]);
    expect(e1.embedding).toBeNull();
    expect(m2.embedding).toBeNull();
    expect(mocks.logger.info).not.toHaveBeenCalled();
    expect(summaryLine()).toMatchObject({
      stoppedEarly: true,
      statusCode: 402,
      reason: "Insufficient credits",
      missingBefore: 2,
      selected: 2,
      embedded: 0,
      stillMissing: 2,
    });
  });

  it("rethrows any other embedding failure so the step retries", async () => {
    workspace("org-a", "ws-1");
    entity("org-a", "ws-1", "e1");
    mocks.embedMany.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(runBackfill(makeStep())).rejects.toThrow("socket hang up");
  });

  it("does not embed a finished batch again when a retried run resumes", async () => {
    workspace("org-a", "ws-1");
    workspace("org-a", "ws-2");
    entity("org-a", "ws-1", "e1");
    entity("org-a", "ws-2", "e2");
    // ws-1's batch writes, then ws-2's write fails once and its step retries.
    mocks.upsertEmbedding.mockImplementationOnce(
      async (id: string, vector: number[], model: string) => {
        const node = mocks.nodes.get(`entity:${id}`) as FakeNode;
        node.embedding = vector;
        node.embeddingModel = model;
      },
    );
    mocks.upsertEmbedding.mockRejectedValueOnce(
      new Error("Neo4j write timed out"),
    );

    const step = makeStep();
    await expect(runBackfill(step)).rejects.toThrow("Neo4j write timed out");
    await runBackfill(step);

    const calls = mocks.embedMany.mock.calls as [
      string[],
      { telemetry: { workspaceId: string } },
    ][];
    expect(calls.map(([, opts]) => opts.telemetry.workspaceId)).toEqual([
      "ws-1",
      "ws-2",
      "ws-2",
    ]);
    expect(nodesOf().every((n) => n.embedding !== null)).toBe(true);
  });

  it("leaves out entities whose connection turned embedding off, and memories with no lesson", async () => {
    mocks.workspaces.push({ id: "ws-1", orgId: "org-a" });
    mocks.connections.push(
      { id: "con-on", workspaceId: "ws-1", deliveryConfig: {} },
      {
        id: "con-off",
        workspaceId: "ws-1",
        deliveryConfig: { semanticInference: { enabled: false } },
      },
      {
        id: "con-partial",
        workspaceId: "ws-1",
        deliveryConfig: {
          semanticInference: {
            enabled: true,
            perRecordType: { commit: false, issue: true },
          },
        },
      },
    );
    const on = entity("org-a", "ws-1", "on", { connectionId: "con-on" });
    const off = entity("org-a", "ws-1", "off", { connectionId: "con-off" });
    const commit = entity("org-a", "ws-1", "commit", {
      connectionId: "con-partial",
      sourceRecordType: "commit",
    });
    const issue = entity("org-a", "ws-1", "issue", {
      connectionId: "con-partial",
      sourceRecordType: "issue",
    });
    const orphan = entity("org-a", "ws-1", "orphan", {
      connectionId: "con-gone",
    });
    const blank = memory("org-a", "ws-1", "blank", "   ");

    await runBackfill(makeStep());

    expect(on.embedding).not.toBeNull();
    expect(issue.embedding).not.toBeNull();
    expect(off.embedding).toBeNull();
    expect(commit.embedding).toBeNull();
    expect(orphan.embedding).toBeNull();
    expect(blank.embedding).toBeNull();
    expect(summaryLine()).toMatchObject({
      missingBefore: 2,
      excluded: 4,
      embedded: 2,
      stillMissing: 0,
    });
  });

  it("skips a workspace whose graph cannot be read and embeds the others", async () => {
    workspace("org-a", "ws-1");
    workspace("org-b", "ws-2");
    const e1 = entity("org-a", "ws-1", "e1");
    const e2 = entity("org-b", "ws-2", "e2");
    mocks.unreadableWorkspaces.add("ws-1");

    await runBackfill(makeStep());

    expect(e1.embedding).toBeNull();
    expect(e2.embedding).not.toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a", workspaceId: "ws-1" }),
      "embeddings.backfill: skipped a workspace whose graph could not be read",
    );
    expect(summaryLine()).toMatchObject({
      workspaces: 2,
      workspacesFailed: 1,
      embedded: 1,
    });
  });

  it("counts a node embedded or edited since selection as skipped", async () => {
    workspace("org-a", "ws-1");
    const m1 = memory("org-a", "ws-1", "m1");
    const m2 = memory("org-a", "ws-1", "m2");
    const m3 = memory("org-a", "ws-1", "m3");
    const step = makeStep();
    step.before = (name) => {
      // Ingestion embeds m1 between selection and the batch.
      if (name === "embed-batch-0") m1.embedding = [9, 9];
    };
    const edited = "Run the migration after the deploy";
    mocks.embedMany.mockImplementationOnce(async (texts: string[]) => {
      // An operator edits m3 while the backfill embeds its old lesson, and the
      // edit stores a vector of the new one.
      m3.lesson = edited;
      m3.embedding = vectorFor(edited);
      return texts.map(vectorFor);
    });

    await runBackfill(step);

    expect(mocks.embedMany.mock.calls[0]?.[0]).toEqual([
      m2.lesson,
      "Run the migration before m3",
    ]);
    expect(m1.embedding).toEqual([9, 9]);
    expect(m2.embedding).toEqual(vectorFor(m2.lesson!));
    expect(m3.embedding).toEqual(vectorFor(edited));
    expect(summaryLine()).toMatchObject({
      missingBefore: 3,
      embedded: 1,
      skipped: 2,
      stillMissing: 0,
    });
  });

  it("calls embedMany for nothing when every node in a batch was embedded since selection", async () => {
    workspace("org-a", "ws-1");
    const m1 = memory("org-a", "ws-1", "m1");
    const step = makeStep();
    step.before = (name) => {
      if (name === "embed-batch-0") m1.embedding = [9, 9];
    };

    await runBackfill(step);

    expect(mocks.embedMany).not.toHaveBeenCalled();
    expect(summaryLine()).toMatchObject({ embedded: 0, skipped: 1 });
  });
});
