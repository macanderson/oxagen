import { describe, expect, it, vi, beforeEach } from "vitest";
import type { StepContext } from "@oxagen/functions";
import type {
  DeferredSelection,
  ReconcileOutcome,
} from "@oxagen/ingestion/dedup/reconcile";

interface Scope {
  orgId: string;
  workspaceId: string;
}

type Handler = (ctx: { step: StepContext }) => Promise<unknown>;

interface Harness {
  handlers: Map<string, Handler>;
  configs: Map<string, unknown>;
  triggers: Map<string, unknown>;
  scope: Scope | null;
  workspaces: Scope[];
  /** Marked node ids per workspace, each with the outcome it reconciles to. */
  deferred: Map<string, { id: string; outcome: ReconcileOutcome }[]>;
  /** Marked nodes per workspace that have no vector yet. */
  withoutVector: Map<string, number>;
  unreadable: Set<string>;
  findDeferredNodes: ReturnType<typeof vi.fn>;
  reconcileDeferredNode: ReturnType<typeof vi.fn>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
}

const mocks = vi.hoisted(
  (): Harness => ({
    handlers: new Map(),
    configs: new Map(),
    triggers: new Map(),
    scope: null,
    workspaces: [],
    deferred: new Map(),
    withoutVector: new Map(),
    unreadable: new Set(),
    findDeferredNodes: vi.fn(),
    reconcileDeferredNode: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }),
);

vi.mock("../create-function", () => ({
  createFunction: (
    config: { id: string },
    trigger: unknown,
    handler: Handler,
  ) => {
    mocks.handlers.set(config.id, handler);
    mocks.configs.set(config.id, config);
    mocks.triggers.set(config.id, trigger);
    return [{ config, trigger }];
  },
}));

vi.mock("../logger", () => ({ logger: mocks.logger }));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (scope: Scope, fn: () => Promise<unknown>) => {
    const previous = mocks.scope;
    mocks.scope = scope;
    try {
      return await fn();
    } finally {
      mocks.scope = previous;
    }
  },
}));

vi.mock("../lib/embedding-backfill", () => ({
  listWorkspaces: async () => mocks.workspaces,
}));

vi.mock("@oxagen/ingestion/dedup/reconcile", () => ({
  findDeferredNodes: mocks.findDeferredNodes,
  reconcileDeferredNode: mocks.reconcileDeferredNode,
}));

const {
  MAX_NODES_PER_RUN,
  RECONCILE_BATCH_SIZE,
  runReconcile,
  similarityReconcile,
} = await import("./similarity.reconcile");

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The scope the fakes run in. A call outside a tenant scope is a defect. */
function currentScope(): Scope {
  if (!mocks.scope) throw new Error("no tenant scope");
  return mocks.scope;
}

/**
 * The graph seam, answered per workspace from `mocks.deferred`. Reconciling a
 * node removes it from the set unless its outcome keeps the mark.
 */
function installGraph(): void {
  mocks.findDeferredNodes.mockImplementation(
    async (limit: number): Promise<DeferredSelection> => {
      const { workspaceId } = currentScope();
      if (mocks.unreadable.has(workspaceId)) {
        throw new Error("graph plane is disabled for this organisation");
      }
      const marked = mocks.deferred.get(workspaceId) ?? [];
      const withoutVector = mocks.withoutVector.get(workspaceId) ?? 0;
      return {
        deferred: marked.length + withoutVector,
        withoutVector,
        ids: marked.slice(0, Math.max(0, limit)).map((n) => n.id),
      };
    },
  );
  mocks.reconcileDeferredNode.mockImplementation(
    async (id: string, orgId: string): Promise<ReconcileOutcome> => {
      const scope = currentScope();
      if (scope.orgId !== orgId) throw new Error("org outside the scope");
      const marked = mocks.deferred.get(scope.workspaceId) ?? [];
      const node = marked.find((n) => n.id === id);
      if (!node) return { status: "not_deferred" };
      const keeps =
        node.outcome.status === "no_vector" ||
        node.outcome.status === "search_failed";
      if (!keeps) {
        mocks.deferred.set(
          scope.workspaceId,
          marked.filter((n) => n.id !== id),
        );
      }
      return node.outcome;
    },
  );
}

function workspace(
  orgId: string,
  workspaceId: string,
  nodes: { id: string; outcome: ReconcileOutcome }[],
  withoutVector = 0,
): void {
  mocks.workspaces.push({ orgId, workspaceId });
  mocks.deferred.set(workspaceId, nodes);
  mocks.withoutVector.set(workspaceId, withoutVector);
}

function unmatched(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    outcome: { status: "unmatched" } satisfies ReconcileOutcome,
  }));
}

/** Inngest's step for one attempt, recording the name of each step it runs. */
function makeStep(): StepContext & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    async run<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      names.push(name);
      return await fn();
    },
    sendEvent: vi.fn(async () => undefined),
    waitForEvent: vi.fn(async () => null),
    sleep: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope = null;
  mocks.workspaces = [];
  mocks.deferred = new Map();
  mocks.withoutVector = new Map();
  mocks.unreadable = new Set();
  installGraph();
});

// ── Registration ─────────────────────────────────────────────────────────────

describe("similarity/reconcile registration", () => {
  it("runs on a schedule, 15 minutes after each embedding backfill, one run at a time", () => {
    expect(similarityReconcile).toBeDefined();
    expect(mocks.triggers.get("similarity/reconcile")).toEqual({
      cron: "15,45 * * * *",
    });
    expect(mocks.configs.get("similarity/reconcile")).toMatchObject({
      concurrency: { limit: 1 },
    });
  });

  it("runs the pass from the registered handler", async () => {
    workspace("org-1", "ws-1", unmatched(2, "n"));
    const handler = mocks.handlers.get("similarity/reconcile");
    if (!handler) throw new Error("no handler");

    const summary = await handler({ step: makeStep() });

    expect(summary).toMatchObject({ unmatched: 2, stillDeferred: 0 });
  });
});

// ── A run ────────────────────────────────────────────────────────────────────

describe("runReconcile", () => {
  it("reconciles every workspace's marked nodes inside that workspace's scope", async () => {
    workspace("org-1", "ws-1", [
      {
        id: "n-linked",
        outcome: {
          status: "linked",
          principalNodeId: "p-1",
          confidence: 0.95,
          tentative: false,
        },
      },
      { id: "n-unmatched", outcome: { status: "unmatched" } },
    ]);
    workspace("org-2", "ws-2", [
      { id: "n-already", outcome: { status: "already_linked" } },
    ]);

    const summary = await runReconcile(makeStep());

    expect(mocks.reconcileDeferredNode.mock.calls).toEqual([
      ["n-linked", "org-1"],
      ["n-unmatched", "org-1"],
      ["n-already", "org-2"],
    ]);
    expect(summary).toEqual({
      workspaces: 2,
      workspacesFailed: 0,
      deferredBefore: 3,
      withoutVector: 0,
      selected: 3,
      linked: 1,
      unmatched: 1,
      alreadyLinked: 1,
      noVector: 0,
      notDeferred: 0,
      searchFailed: 0,
      stillDeferred: 0,
    });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      summary,
      "similarity.reconcile: run complete",
    );
  });

  it("counts marked nodes still waiting for a vector and leaves them for later", async () => {
    workspace("org-1", "ws-1", unmatched(1, "n"), 4);

    const summary = await runReconcile(makeStep());

    expect(summary).toMatchObject({
      deferredBefore: 5,
      withoutVector: 4,
      selected: 1,
      unmatched: 1,
      stillDeferred: 4,
    });
  });

  it("keeps the mark on a node whose search the index refused, and says so", async () => {
    workspace("org-1", "ws-1", [
      {
        id: "n-refused",
        outcome: { status: "search_failed", error: "index populating" },
      },
      { id: "n-no-vector", outcome: { status: "no_vector" } },
    ]);

    const summary = await runReconcile(makeStep());

    expect(summary).toMatchObject({
      searchFailed: 1,
      noVector: 1,
      stillDeferred: 2,
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "n-refused", err: "index populating" }),
      expect.stringContaining("refused the search"),
    );
  });

  it("splits a workspace's nodes into steps of RECONCILE_BATCH_SIZE", async () => {
    workspace("org-1", "ws-1", unmatched(RECONCILE_BATCH_SIZE * 2 + 1, "n"));
    const step = makeStep();

    await runReconcile(step);

    expect(step.names).toEqual([
      "select-deferred",
      "reconcile-batch-0",
      "reconcile-batch-1",
      "reconcile-batch-2",
    ]);
  });

  it("stops selecting at MAX_NODES_PER_RUN and still counts every workspace", async () => {
    workspace("org-1", "ws-1", unmatched(MAX_NODES_PER_RUN - 10, "a"));
    workspace("org-1", "ws-2", unmatched(30, "b"));
    workspace("org-2", "ws-3", unmatched(5, "c"));

    const summary = await runReconcile(makeStep());

    expect(mocks.findDeferredNodes.mock.calls).toEqual([
      [MAX_NODES_PER_RUN],
      [10],
      [0],
    ]);
    expect(summary).toMatchObject({
      deferredBefore: MAX_NODES_PER_RUN + 25,
      selected: MAX_NODES_PER_RUN,
      stillDeferred: 25,
    });
  });

  it("skips a workspace whose graph cannot be read and runs the rest", async () => {
    workspace("org-1", "ws-down", unmatched(3, "a"));
    workspace("org-2", "ws-up", unmatched(2, "b"));
    mocks.unreadable.add("ws-down");

    const summary = await runReconcile(makeStep());

    expect(summary).toMatchObject({
      workspaces: 2,
      workspacesFailed: 1,
      deferredBefore: 2,
      unmatched: 2,
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-down" }),
      expect.stringContaining("could not be read"),
    );
  });

  it("lets a failed batch throw, and the next run picks up what is still marked", async () => {
    workspace("org-1", "ws-1", unmatched(3, "n"));
    // The first node's write fails, so the attempt throws before any node
    // loses its mark.
    mocks.reconcileDeferredNode.mockImplementationOnce(async () => {
      throw new Error("transient");
    });
    await expect(runReconcile(makeStep())).rejects.toThrow("transient");

    const summary = await runReconcile(makeStep());

    expect(summary).toMatchObject({
      deferredBefore: 3,
      unmatched: 3,
      stillDeferred: 0,
    });
  });

  it("counts a node another run reconciled after this one selected it", async () => {
    workspace("org-1", "ws-1", [
      { id: "n-gone", outcome: { status: "not_deferred" } },
    ]);

    const summary = await runReconcile(makeStep());

    expect(summary).toMatchObject({
      deferredBefore: 1,
      notDeferred: 1,
      stillDeferred: 0,
    });
  });

  it("reports an empty run when nothing is marked", async () => {
    workspace("org-1", "ws-1", []);

    const summary = await runReconcile(makeStep());

    expect(summary).toMatchObject({
      deferredBefore: 0,
      selected: 0,
      stillDeferred: 0,
    });
    expect(mocks.reconcileDeferredNode).not.toHaveBeenCalled();
  });
});
