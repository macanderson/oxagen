// Unit tests for research.swarm.ingest-graph.
//
// The function triggers on agent/subagent.fanout.completed, loads the fan-out's
// child runs, and feeds each completed web.search child's hits to graph.ingest.
// We capture the handler via a mocked create-function, script the (mocked)
// withTenantDb select to return runs, and assert the graph.ingest invocations.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  selectRows: [] as unknown[],
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(mocks.selectRows),
          }),
        }),
      }),
  };
});

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
  event: { data: { orgId: string; workspaceId: string; fanoutId: string } };
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

const mod = await import("./research.swarm.ingest-graph");
const { buildIngestText } = mod;

const step = { run: async (_name: string, fn: () => Promise<unknown>) => fn() };
const EVENT = {
  event: { data: { orgId: "org_1", workspaceId: "ws_1", fanoutId: "fan_1" } },
  step,
};

function searchRun(query: string, results: unknown[], status = "completed") {
  return {
    capabilityName: "web.search",
    status,
    inputPayload: { query },
    outputPayload: { results },
  };
}

describe("research.swarm.ingest-graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.invoke.mockResolvedValue({ nodeIds: [], edgeIds: [] });
  });

  it("registers on the fanout-completed event, capped at plan concurrency (5)", () => {
    expect(capturedHandler).toBeTypeOf("function");
    expect(capturedOpts?.id).toBe("research.swarm.ingest-graph");
    expect(capturedOpts?.concurrency.limit).toBe(5);
    expect(capturedTrigger?.event).toBe("agent/subagent.fanout.completed");
  });

  it("feeds each completed web.search child's hits to graph.ingest", async () => {
    mocks.selectRows = [
      searchRun("ai memory startups", [
        { title: "Mem0 raises $24M", url: "https://a.com", content: "long-term memory" },
      ]),
      searchRun("RAG startups", [
        { title: "Ragie $5.5M", url: "https://b.com", snippet: "RAG dev" },
      ]),
    ];

    const result = (await capturedHandler!(EVENT)) as { ingested: number; skipped: boolean };

    expect(result).toEqual({ fanoutId: "fan_1", ingested: 2, skipped: false });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    // First call: capability name, text + sourceUrl, runner ctx.
    const [cap, input, ctx] = mocks.invoke.mock.calls[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(cap).toBe("graph.ingest");
    expect(input.sourceUrl).toBe("https://a.com");
    expect(String(input.text)).toContain("Mem0 raises $24M");
    expect(String(input.text)).toContain("Search query: ai memory startups");
    expect(ctx).toMatchObject({ orgId: "org_1", workspaceId: "ws_1", surface: "runner" });
  });

  it("is inert when the fan-out has no completed web.search children", async () => {
    mocks.selectRows = [
      { capabilityName: "agent.tool.list", status: "completed", inputPayload: {}, outputPayload: {} },
      searchRun("pending one", [{ title: "x", url: "https://x.com" }], "running"),
    ];

    const result = (await capturedHandler!(EVENT)) as { ingested: number; skipped: boolean };

    expect(result).toEqual({ fanoutId: "fan_1", ingested: 0, skipped: true });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("skips a web.search child with zero hits without calling graph.ingest", async () => {
    mocks.selectRows = [searchRun("no hits", [])];
    const result = (await capturedHandler!(EVENT)) as { ingested: number; skipped: boolean };
    expect(result.ingested).toBe(0);
    expect(result.skipped).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("does not abort the projection when one query's graph.ingest throws", async () => {
    mocks.selectRows = [
      searchRun("q1", [{ title: "t1", url: "https://1.com", content: "c1" }]),
      searchRun("q2", [{ title: "t2", url: "https://2.com", content: "c2" }]),
    ];
    mocks.invoke.mockRejectedValueOnce(new Error("neo4j down")).mockResolvedValueOnce({});

    const result = (await capturedHandler!(EVENT)) as { ingested: number };

    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(result.ingested).toBe(1); // the second query still ingested
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
    expect(buildIngestText("q", [{ content: "x".repeat(200_000) }]).length).toBeLessThanOrEqual(90_000);
  });
});
