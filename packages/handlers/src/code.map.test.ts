/**
 * code.map handler tests.
 *
 * Strategy: mock embedText, scopedSession, and runInTenantScope — no real Neo4j
 * or AI gateway call required. Verify:
 *   - Embeds the query with executionStepId: null (billing correctness)
 *   - Scopes file Cypher by BOTH orgId AND workspaceId (tenant-isolation guard)
 *   - BigInt-wraps LIMIT params so Neo4j receives INTEGER not Float
 *   - Returns the structured bundle shape (files, symbols, calls, recentChanges)
 *   - Includes optional domain when present, omits when absent
 *   - Traverses CONTAINS to gather symbols for matched files
 *   - Returns empty calls/recentChanges when those edges are absent (graceful degradation)
 *   - Filters only file nodes when kinds=["file"] (skips symbol/call/commit queries)
 *   - Closes the session even when run throws
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  close: vi.fn(async () => undefined),
  embedText: vi.fn(),
}));

vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: mocks.run, close: mocks.close }),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: async (_scope: unknown, fn: () => Promise<void>) => fn(),
}));

vi.mock("@oxagen/ai", () => ({
  embedText: mocks.embedText,
}));

import { codeMapHandler } from "./code.map";
import { TEST_CTX as CTX } from "./test-utils/fixtures";

const VECTOR = new Array(1536).fill(0.1);

function makeRows(rows: Record<string, unknown>[]) {
  return {
    records: rows.map((fields) => ({
      get: (key: string) => (key in fields ? fields[key] : null),
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.embedText.mockResolvedValue(VECTOR);
  // Default: no files, no symbols, no calls, no commits.
  mocks.run.mockResolvedValue(makeRows([]));
});

describe("codeMapHandler", () => {
  it("calls embedText with executionStepId: null (billing correctness)", async () => {
    await codeMapHandler({ query: "payments", limit: 10 }, CTX);
    expect(mocks.embedText).toHaveBeenCalledTimes(1);
    const opts = mocks.embedText.mock.calls[0]![1] as {
      telemetry: { executionStepId: unknown };
    };
    expect(opts.telemetry.executionStepId).toBeNull();
  });

  it("scopes file Cypher by BOTH orgId AND workspaceId (tenant-isolation guard)", async () => {
    await codeMapHandler({ query: "payments", limit: 5 }, CTX);
    const cypher = mocks.run.mock.calls[0]![0] as string;
    expect(cypher).toContain("n.orgId = $orgId");
    expect(cypher).toContain("n.workspaceId = $workspaceId");
  });

  it("BigInt-wraps the k and limit params for Neo4j INTEGER type", async () => {
    await codeMapHandler({ query: "auth", limit: 7 }, CTX);
    const params = mocks.run.mock.calls[0]![1] as Record<string, unknown>;
    expect(typeof params.k).toBe("bigint");
    expect(typeof params.limit).toBe("bigint");
  });

  it("returns empty bundle when no files match", async () => {
    const result = await codeMapHandler({ query: "nope", limit: 10 }, CTX);
    expect(result.files).toEqual([]);
    expect(result.symbols).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(result.recentChanges).toEqual([]);
  });

  it("returns structured bundle with files, symbols, and empty calls/commits", async () => {
    // First run() = file vector search
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "file-1",
          path: "src/billing/stripe.ts",
          language: "typescript",
          displayName: "stripe.ts",
          domain: "billing",
          score: 0.95,
        },
      ]),
    );
    // Second run() = CONTAINS symbol traversal
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          nodeId: "sym-1",
          name: "createPaymentIntent",
          kind: "function",
          path: "src/billing/stripe.ts",
          startLine: 10,
          endLine: 40,
          signature: "async function createPaymentIntent(amount: number): Promise<PaymentIntent>",
          docComment: "Creates a Stripe payment intent",
          domain: "billing",
          score: 1.0,
        },
      ]),
    );
    // Third run() = CALLS edges (empty)
    mocks.run.mockResolvedValueOnce(makeRows([]));
    // Fourth run() = commits (empty)
    mocks.run.mockResolvedValueOnce(makeRows([]));

    const result = await codeMapHandler({ query: "payments", limit: 10 }, CTX);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      nodeId: "file-1",
      path: "src/billing/stripe.ts",
      language: "typescript",
      displayName: "stripe.ts",
      domain: "billing",
      score: 0.95,
    });

    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]).toMatchObject({
      nodeId: "sym-1",
      name: "createPaymentIntent",
      kind: "function",
      path: "src/billing/stripe.ts",
      startLine: 10,
      endLine: 40,
      signature: "async function createPaymentIntent(amount: number): Promise<PaymentIntent>",
      docComment: "Creates a Stripe payment intent",
      domain: "billing",
    });

    expect(result.calls).toEqual([]);
    expect(result.recentChanges).toEqual([]);
  });

  it("includes call edges when CALLS relationships are present", async () => {
    // File search
    mocks.run.mockResolvedValueOnce(
      makeRows([{ nodeId: "f1", path: "a.ts", language: "typescript", displayName: "a.ts", domain: null, score: 0.9 }]),
    );
    // Symbol traversal
    mocks.run.mockResolvedValueOnce(
      makeRows([
        { nodeId: "s1", name: "foo", kind: "function", path: "a.ts", startLine: 1, endLine: 5, signature: "foo()", docComment: null, domain: null, score: 1.0 },
        { nodeId: "s2", name: "bar", kind: "function", path: "a.ts", startLine: 7, endLine: 12, signature: "bar()", docComment: null, domain: null, score: 1.0 },
      ]),
    );
    // CALLS edges
    mocks.run.mockResolvedValueOnce(
      makeRows([
        { callerNodeId: "s1", calleeNodeId: "s2", callerName: "foo", calleeName: "bar" },
      ]),
    );
    // Commits (empty)
    mocks.run.mockResolvedValueOnce(makeRows([]));

    const result = await codeMapHandler({ query: "foo bar", limit: 10 }, CTX);

    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]).toEqual({
      callerNodeId: "s1",
      calleeNodeId: "s2",
      callerName: "foo",
      calleeName: "bar",
    });
  });

  it("populates recentChanges when commit edges are present", async () => {
    // File search
    mocks.run.mockResolvedValueOnce(
      makeRows([{ nodeId: "f1", path: "a.ts", language: "typescript", displayName: "a.ts", domain: null, score: 0.9 }]),
    );
    // Symbol traversal (empty)
    mocks.run.mockResolvedValueOnce(makeRows([]));
    // CALLS (not called — no symbols)
    // Commits
    mocks.run.mockResolvedValueOnce(
      makeRows([
        {
          commitSha: "abc123",
          message: "fix: billing rounding error",
          authorName: "Alice",
          committedAt: "2026-06-20T12:00:00Z",
          modifiedFiles: ["a.ts"],
        },
      ]),
    );

    const result = await codeMapHandler({ query: "billing", limit: 10 }, CTX);

    expect(result.recentChanges).toHaveLength(1);
    expect(result.recentChanges[0]).toEqual({
      commitSha: "abc123",
      message: "fix: billing rounding error",
      authorName: "Alice",
      committedAt: "2026-06-20T12:00:00Z",
      modifiedFiles: ["a.ts"],
    });
  });

  it("degrades gracefully when CALLS edges throw (index absent)", async () => {
    // File search
    mocks.run.mockResolvedValueOnce(
      makeRows([{ nodeId: "f1", path: "a.ts", language: "typescript", displayName: "a.ts", domain: null, score: 0.9 }]),
    );
    // Symbol traversal returns one symbol
    mocks.run.mockResolvedValueOnce(
      makeRows([{ nodeId: "s1", name: "foo", kind: "function", path: "a.ts", startLine: 1, endLine: 5, signature: "foo()", docComment: null, domain: null, score: 1.0 }]),
    );
    // CALLS query throws (e.g. relationship type not yet defined)
    mocks.run.mockRejectedValueOnce(new Error("Relationship type CALLS is not defined"));
    // Commits
    mocks.run.mockResolvedValueOnce(makeRows([]));

    const result = await codeMapHandler({ query: "foo", limit: 5 }, CTX);

    // Should not throw; calls should be empty
    expect(result.calls).toEqual([]);
    expect(result.symbols).toHaveLength(1);
  });

  it("degrades gracefully when commit edges throw (Commit label absent)", async () => {
    // File search
    mocks.run.mockResolvedValueOnce(
      makeRows([{ nodeId: "f1", path: "a.ts", language: "typescript", displayName: "a.ts", domain: null, score: 0.9 }]),
    );
    // Symbol traversal (empty)
    mocks.run.mockResolvedValueOnce(makeRows([]));
    // Commit query throws
    mocks.run.mockRejectedValueOnce(new Error("Label Commit is not defined"));

    const result = await codeMapHandler({ query: "auth", limit: 5 }, CTX);

    expect(result.recentChanges).toEqual([]);
  });

  it("includes domain filter in Cypher when domain option is provided", async () => {
    await codeMapHandler({ query: "payments", limit: 5, domain: "billing" }, CTX);
    const cypher = mocks.run.mock.calls[0]![0] as string;
    expect(cypher).toContain("coalesce(n.domain, '') = $domain");
  });

  it("omits domain filter from Cypher when domain is not provided", async () => {
    await codeMapHandler({ query: "payments", limit: 5 }, CTX);
    const cypher = mocks.run.mock.calls[0]![0] as string;
    expect(cypher).not.toContain("$domain");
  });

  it("omits domain property from file output when node has no domain", async () => {
    mocks.run.mockResolvedValueOnce(
      makeRows([{ nodeId: "f1", path: "a.ts", language: "typescript", displayName: "a.ts", domain: null, score: 0.9 }]),
    );
    mocks.run.mockResolvedValue(makeRows([]));

    const result = await codeMapHandler({ query: "auth", limit: 5 }, CTX);

    expect("domain" in result.files[0]!).toBe(false);
  });

  it("skips symbol/call/commit queries when kinds is ['file']", async () => {
    mocks.run.mockResolvedValueOnce(
      makeRows([{ nodeId: "f1", path: "a.ts", language: "typescript", displayName: "a.ts", domain: null, score: 0.9 }]),
    );

    const result = await codeMapHandler({ query: "auth", limit: 5, kinds: ["file"] }, CTX);

    // Only one run() call for files — symbols/calls/commits are skipped.
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(result.files).toHaveLength(1);
    expect(result.symbols).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(result.recentChanges).toEqual([]);
  });

  it("closes the session even when the file search throws", async () => {
    mocks.run.mockRejectedValueOnce(new Error("Neo4j down"));
    await expect(codeMapHandler({ query: "payments", limit: 5 }, CTX)).rejects.toThrow("Neo4j down");
    expect(mocks.close).toHaveBeenCalled();
  });
});
