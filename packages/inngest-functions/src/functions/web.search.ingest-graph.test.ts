// Unit tests for web.search.ingest-graph.
//
// The function triggers on web/search.completed (emitted by the web.search
// handler for every search with hits — chat agent, swarm children, API, MCP,
// CLI), builds an extraction document from the query + hits, and feeds it to
// graph.ingest. We capture the handler via a mocked create-function and assert
// the graph.ingest invocation.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: mocks.invoke,
}));

vi.mock("../logger", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn() },
}));

type StepCtx = {
  event: {
    data: {
      orgId: string;
      workspaceId: string;
      query?: unknown;
      results?: unknown;
    };
  };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
};
let capturedHandler: ((ctx: StepCtx) => Promise<unknown>) | null = null;
let capturedOpts: { id: string; concurrency: { limit: number } } | null = null;
let capturedTrigger: { event: string } | null = null;

vi.mock("../create-function", () => ({
  createFunction: (
    opts: { id: string; concurrency: { limit: number } },
    trigger: { event: string },
    handler: (ctx: StepCtx) => Promise<unknown>,
  ) => {
    capturedOpts = opts;
    capturedTrigger = trigger;
    capturedHandler = handler;
    return [{ id: opts.id }];
  },
}));

const mod = await import("./web.search.ingest-graph");
const { buildIngestText } = mod;

const step = { run: async (_name: string, fn: () => Promise<unknown>) => fn() };

function event(query: unknown, results: unknown) {
  return {
    event: { data: { orgId: "org_1", workspaceId: "ws_1", query, results } },
    step,
  };
}

describe("web.search.ingest-graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue({ entities: [], relationships: [], summary: "" });
  });

  it("registers on the web/search.completed event, capped at plan concurrency (5)", () => {
    expect(capturedHandler).toBeTypeOf("function");
    expect(capturedOpts?.id).toBe("web.search.ingest-graph");
    expect(capturedOpts?.concurrency.limit).toBe(5);
    expect(capturedTrigger?.event).toBe("web/search.completed");
  });

  it("feeds the query + hits to graph.ingest with provenance and runner ctx", async () => {
    const result = (await capturedHandler!(
      event("ai memory startups", [
        { title: "Mem0 raises $24M", url: "https://a.com", content: "long-term memory" },
        { title: "Ragie $5.5M", url: "https://b.com", content: "RAG dev tooling" },
      ]),
    )) as { ingested: number; skipped: boolean };

    expect(result).toEqual({ ingested: 1, skipped: false });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    const [cap, input, ctx] = mocks.invoke.mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(cap).toBe("graph.ingest");
    expect(input.sourceUrl).toBe("https://a.com");
    expect(String(input.text)).toContain("Search query: ai memory startups");
    expect(String(input.text)).toContain("Mem0 raises $24M");
    expect(String(input.text)).toContain("Ragie $5.5M");
    expect(ctx).toMatchObject({ orgId: "org_1", workspaceId: "ws_1", surface: "runner" });
  });

  it("skips when there are no hits", async () => {
    const result = (await capturedHandler!(event("empty", []))) as {
      ingested: number;
      skipped: boolean;
    };
    expect(result).toEqual({ ingested: 0, skipped: true });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("skips when the built text is empty (hits carry no usable fields)", async () => {
    const result = (await capturedHandler!(event("", [{}, {}]))) as {
      ingested: number;
      skipped: boolean;
    };
    expect(result).toEqual({ ingested: 0, skipped: true });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("reports ingested:0 (not a throw) when graph.ingest fails", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("neo4j down"));
    const result = (await capturedHandler!(
      event("q1", [{ title: "t1", url: "https://1.com", content: "c1" }]),
    )) as { ingested: number; skipped: boolean };

    expect(result).toEqual({ ingested: 0, skipped: false });
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });
});

describe("buildIngestText", () => {
  it("composes the query line and one line per hit (title — body — url)", () => {
    const text = buildIngestText("memory startups", [
      { title: "Mem0", content: "raises $24M", url: "https://a.com" },
      { title: "Cognee", snippet: "$7.5M", url: "https://b.com" },
    ]);
    expect(text).toContain("Search query: memory startups");
    expect(text).toContain("Mem0 — raises $24M — https://a.com");
    expect(text).toContain("Cognee — $7.5M — https://b.com");
  });

  it("tolerates missing fields and caps length", () => {
    const text = buildIngestText("", [{ url: "https://only-url.com" }, { title: "only title" }]);
    expect(text).toContain("https://only-url.com");
    expect(text).toContain("only title");
    expect(text).not.toContain("Search query:");
    expect(buildIngestText("q", [{ content: "x".repeat(200_000) }]).length).toBeLessThanOrEqual(
      90_000,
    );
  });
});
