import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fake graph ───────────────────────────────────────────────────────────────
// The reconcile job reads and writes through scopedSession(). The fake session
// answers each query from one marked node and a list of index candidates, and
// records every query so a test can say which ones ran.

interface FakeNode {
  embedding: number[] | null;
  entityType: string;
  displayName: string | null;
  properties: string | null;
  /** Outgoing ALIAS_OF edges, as the read query counts them. */
  principals: number;
}

interface Candidate {
  nodeId: string;
  displayName: string;
  properties: string | null;
  score: number;
}

interface FakeGraph {
  createAliasEdge: ReturnType<typeof vi.fn>;
  queries: { cypher: string; params: Record<string, unknown> }[];
  node: FakeNode | null;
  candidates: Candidate[];
  searchError: Error | null;
  counts: { deferred: number; withoutVector: number };
  /** Ids the list query returns. A non-string stands for a row with no id. */
  listed: unknown[];
  /** When set, the node read returns this as the stored embedding. */
  brokenEmbedding: unknown[] | null;
  /** Return counts as numbers instead of driver Integers. */
  plainCounts: boolean;
}

const mocks = vi.hoisted(
  (): FakeGraph => ({
    createAliasEdge: vi.fn(),
    queries: [],
    node: null,
    candidates: [],
    searchError: null,
    counts: { deferred: 0, withoutVector: 0 },
    listed: [],
    brokenEmbedding: null,
    plainCounts: false,
  }),
);

function record(map: Record<string, unknown>) {
  return { get: (key: string) => map[key] };
}

/** A count comes back over Bolt as a driver Integer, not a number. */
function driverInt(n: number) {
  return { toNumber: () => n, toString: () => String(n) };
}

function answer(cypher: string) {
  if (cypher.includes("OPTIONAL MATCH (n)-[:ALIAS_OF]")) {
    const node = mocks.node;
    return {
      records: node
        ? [
            record({
              embedding: mocks.brokenEmbedding ?? node.embedding,
              entityType: node.entityType,
              displayName: node.displayName,
              properties: node.properties,
              principals: driverInt(node.principals),
            }),
          ]
        : [],
    };
  }
  if (cypher.includes("db.index.vector.queryNodes")) {
    if (mocks.searchError) throw mocks.searchError;
    return { records: mocks.candidates.map((c) => record({ ...c })) };
  }
  if (cypher.includes("REMOVE n.similarityDeferredAt")) {
    return { records: [] };
  }
  if (cypher.includes("count(n) AS deferred")) {
    return {
      records: [
        record(
          mocks.plainCounts
            ? { ...mocks.counts }
            : {
                deferred: driverInt(mocks.counts.deferred),
                withoutVector: driverInt(mocks.counts.withoutVector),
              },
        ),
      ],
    };
  }
  if (cypher.includes("ORDER BY n.similarityDeferredAt")) {
    return { records: mocks.listed.map((id) => record({ id })) };
  }
  throw new Error(`the fake graph does not answer: ${cypher}`);
}

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({
    run: async (cypher: string, params: Record<string, unknown> = {}) => {
      mocks.queries.push({ cypher, params });
      return answer(cypher);
    },
    close: async () => undefined,
  }),
}));

vi.mock("../../mutations/upsert-entity", () => ({
  createAliasEdge: mocks.createAliasEdge,
  upsertEntityNode: vi.fn(),
}));

// The job searches with a vector the node already has, so it never embeds.
vi.mock("@oxagen/ai", () => ({
  embedText: vi.fn(() => {
    throw new Error("the reconcile job must not embed");
  }),
}));

import { findDeferredNodes, reconcileDeferredNode } from "../reconcile";
import { CONFIRM_THRESHOLD } from "../../types";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ORG = "org-1";
const NODE = "ent_deferred";

function deferredNode(overrides: Partial<FakeNode> = {}): FakeNode {
  return {
    embedding: [0.1, 0.2, 0.3],
    entityType: "person",
    displayName: "Mac Anderson",
    properties: JSON.stringify({ email: "mac@example.com" }),
    principals: 0,
    ...overrides,
  };
}

/** A candidate whose combined score clears CONFIRM_THRESHOLD. */
function strongMatch(): Candidate {
  return {
    nodeId: "ent_principal",
    displayName: "Mac Anderson",
    properties: JSON.stringify({ email: "mac@example.com" }),
    score: 0.98,
  };
}

function ran(fragment: string) {
  return mocks.queries.filter((q) => q.cypher.includes(fragment));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAliasEdge.mockResolvedValue(undefined);
  mocks.queries = [];
  mocks.node = null;
  mocks.candidates = [];
  mocks.searchError = null;
  mocks.counts = { deferred: 0, withoutVector: 0 };
  mocks.listed = [];
  mocks.brokenEmbedding = null;
  mocks.plainCounts = false;
});

// ── reconcileDeferredNode ────────────────────────────────────────────────────

describe("reconcileDeferredNode", () => {
  it("links a node to the match the similarity pass finds, as ingest does", async () => {
    mocks.node = deferredNode();
    mocks.candidates = [strongMatch()];

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome).toEqual({
      status: "linked",
      principalNodeId: "ent_principal",
      confidence: expect.any(Number),
      tentative: false,
    });
    expect(mocks.createAliasEdge).toHaveBeenCalledOnce();
    expect(mocks.createAliasEdge).toHaveBeenCalledWith(
      NODE,
      "ent_principal",
      {
        confidence: outcome.status === "linked" ? outcome.confidence : -1,
        matchReason: "name_embedding",
        tentative: false,
      },
      ORG,
    );
  });

  it("clears the mark on a node it linked", async () => {
    mocks.node = deferredNode();
    mocks.candidates = [strongMatch()];

    await reconcileDeferredNode(NODE, ORG);

    const cleared = ran("REMOVE n.similarityDeferredAt");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.params).toEqual({ nodeId: NODE, orgId: ORG });
  });

  it("marks a match below CONFIRM_THRESHOLD as tentative", async () => {
    mocks.node = deferredNode();
    // 0.9 * 0.4 + 0.4 (email) + 0.2 (same name) = 0.96 is confirmed, so drop
    // the name to land between the two thresholds.
    mocks.candidates = [
      { ...strongMatch(), displayName: "Someone Else Entirely", score: 0.9 },
    ];

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome.status).toBe("linked");
    if (outcome.status !== "linked") return;
    expect(outcome.confidence).toBeLessThan(CONFIRM_THRESHOLD);
    expect(outcome.tentative).toBe(true);
  });

  it("clears the mark and adds no edge when nothing matches", async () => {
    mocks.node = deferredNode();
    mocks.candidates = [
      {
        nodeId: "ent_other",
        displayName: "Completely Different",
        properties: null,
        score: 0.4,
      },
    ];

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome).toEqual({ status: "unmatched" });
    expect(mocks.createAliasEdge).not.toHaveBeenCalled();
    expect(ran("REMOVE n.similarityDeferredAt")).toHaveLength(1);
  });

  it("leaves the mark on a node that still has no vector", async () => {
    mocks.node = deferredNode({ embedding: null });

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome).toEqual({ status: "no_vector" });
    expect(ran("db.index.vector.queryNodes")).toHaveLength(0);
    expect(ran("REMOVE n.similarityDeferredAt")).toHaveLength(0);
    expect(mocks.createAliasEdge).not.toHaveBeenCalled();
  });

  it("reads a stored vector with a non-number entry as no vector", async () => {
    mocks.node = deferredNode();
    mocks.brokenEmbedding = [0.1, "0.2"];

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome).toEqual({ status: "no_vector" });
    expect(ran("db.index.vector.queryNodes")).toHaveLength(0);
  });

  it("leaves the mark when the vector index refuses the search", async () => {
    mocks.node = deferredNode();
    mocks.searchError = new Error("index is still populating");

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome).toEqual({
      status: "search_failed",
      error: "index is still populating",
    });
    expect(ran("REMOVE n.similarityDeferredAt")).toHaveLength(0);
    expect(mocks.createAliasEdge).not.toHaveBeenCalled();
  });

  it("does not link a node again on a retry that stopped after the link", async () => {
    // The step linked the node and failed before it cleared the mark. The
    // retry finds the edge, clears the mark, and writes no second edge.
    mocks.node = deferredNode({ principals: 1 });
    mocks.candidates = [strongMatch()];

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome).toEqual({ status: "already_linked" });
    expect(mocks.createAliasEdge).not.toHaveBeenCalled();
    expect(ran("db.index.vector.queryNodes")).toHaveLength(0);
    expect(ran("REMOVE n.similarityDeferredAt")).toHaveLength(1);
  });

  it("does nothing for a node whose mark is already gone", async () => {
    mocks.node = null;

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome).toEqual({ status: "not_deferred" });
    expect(mocks.queries).toHaveLength(1);
    expect(mocks.createAliasEdge).not.toHaveBeenCalled();
  });

  it("reads only a marked node of this organisation", async () => {
    mocks.node = deferredNode({ embedding: null });

    await reconcileDeferredNode(NODE, ORG);

    const [read] = ran("OPTIONAL MATCH (n)-[:ALIAS_OF]");
    expect(read?.cypher).toContain("{publicId: $nodeId, orgId: $orgId}");
    expect(read?.cypher).toContain("n.similarityDeferredAt IS NOT NULL");
    expect(read?.params).toEqual({ nodeId: NODE, orgId: ORG });
  });

  it("searches with the node's own vector, leaving out itself and every alias", async () => {
    mocks.node = deferredNode();

    await reconcileDeferredNode(NODE, ORG);

    const [search] = ran("db.index.vector.queryNodes");
    // A node always matches its own vector, and an alias candidate would let
    // two duplicates from one outage link to each other.
    expect(search?.cypher).toContain("n.publicId <> $excludeNodeId");
    expect(search?.cypher).toContain("NOT (n)-[:ALIAS_OF]->(:EntityNode)");
    expect(search?.params).toMatchObject({
      vector: [0.1, 0.2, 0.3],
      orgId: ORG,
      entityType: "person",
      excludeNodeId: NODE,
    });
  });

  it("scores the node's stored name and properties", async () => {
    // The candidate matches on email alone. Without the node's stored
    // properties the score would be 0.98 * 0.4 = 0.39, under ALIAS_THRESHOLD.
    mocks.node = deferredNode({ displayName: null });
    mocks.candidates = [{ ...strongMatch(), displayName: "Unrelated" }];

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome.status).toBe("linked");
  });

  it("reads malformed stored properties as none", async () => {
    mocks.node = deferredNode({ properties: "{not json" });
    mocks.candidates = [
      { ...strongMatch(), displayName: "Unrelated", score: 0.9 },
    ];

    const outcome = await reconcileDeferredNode(NODE, ORG);

    expect(outcome).toEqual({ status: "unmatched" });
  });

  it("lets a failed write throw so the step retries", async () => {
    mocks.node = deferredNode();
    mocks.candidates = [strongMatch()];
    mocks.createAliasEdge.mockRejectedValueOnce(new Error("leader switched"));

    await expect(reconcileDeferredNode(NODE, ORG)).rejects.toThrow(
      "leader switched",
    );
    // The mark stays, so the retry selects the node again.
    expect(ran("REMOVE n.similarityDeferredAt")).toHaveLength(0);
  });
});

// ── findDeferredNodes ────────────────────────────────────────────────────────

describe("findDeferredNodes", () => {
  it("counts the marked nodes and lists the ones with a vector", async () => {
    mocks.counts = { deferred: 5, withoutVector: 2 };
    mocks.listed = ["ent_a", "ent_b", "ent_c"];

    const selection = await findDeferredNodes(10);

    expect(selection).toEqual({
      deferred: 5,
      withoutVector: 2,
      ids: ["ent_a", "ent_b", "ent_c"],
    });
    const [list] = ran("ORDER BY n.similarityDeferredAt");
    expect(list?.cypher).toContain("n.embedding IS NOT NULL");
    expect(list?.cypher).toContain(
      "{orgId: $orgId, workspaceId: $workspaceId}",
    );
    expect(list?.params).toEqual({ limit: BigInt(10) });
  });

  it("reads counts that arrive as plain numbers", async () => {
    mocks.plainCounts = true;
    mocks.counts = { deferred: 2, withoutVector: 1 };
    mocks.listed = ["ent_a"];

    const selection = await findDeferredNodes(10);

    expect(selection).toEqual({ deferred: 2, withoutVector: 1, ids: ["ent_a"] });
  });

  it("counts without listing when the run has no room left", async () => {
    mocks.counts = { deferred: 4, withoutVector: 0 };

    const selection = await findDeferredNodes(0);

    expect(selection).toEqual({ deferred: 4, withoutVector: 0, ids: [] });
    expect(ran("ORDER BY n.similarityDeferredAt")).toHaveLength(0);
  });

  it("lists nothing when every marked node still waits for a vector", async () => {
    mocks.counts = { deferred: 3, withoutVector: 3 };

    const selection = await findDeferredNodes(10);

    expect(selection.ids).toEqual([]);
    expect(ran("ORDER BY n.similarityDeferredAt")).toHaveLength(0);
  });

  it("skips a listed row with no publicId", async () => {
    mocks.counts = { deferred: 2, withoutVector: 0 };
    mocks.listed = ["ent_a", null];

    const selection = await findDeferredNodes(10);

    expect(selection.ids).toEqual(["ent_a"]);
  });
});
