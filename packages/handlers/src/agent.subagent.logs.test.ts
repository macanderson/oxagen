import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@oxagen/oxagen/kernel", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

const persistGeneratedAsset = vi.fn();
vi.mock("./generated-asset.persist", () => ({
  persistGeneratedAsset: (...a: unknown[]) => persistGeneratedAsset(...a),
}));

import type { CapabilityContext } from "@oxagen/oxagen";
import {
  agentSubagentLogsHandler,
  buildLogMarkdown,
} from "./agent.subagent.logs";

const ctx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: null,
};

const webChild = {
  runId: "run_1",
  capabilityName: "search_web",
  status: "completed",
  summary: "1 result",
  input: { query: "USS Nautilus crew" },
  output: {
    results: [
      {
        title: "Crew roster",
        url: "https://x/crew",
        content: "The first crew served under Wilkinson.",
      },
    ],
  },
  outputBytes: 94,
  errorReason: null,
};

describe("buildLogMarkdown", () => {
  it("renders per-subagent query + each result, traceable to individual hits", () => {
    const md = buildLogMarkdown({
      title: "Swarm log",
      fanoutId: "fan_1",
      status: "completed",
      children: [webChild],
      timeline: [
        {
          runId: "run_1",
          capabilityName: "search_web",
          status: "completed",
          startedAt: "2026-06-18T00:00:00Z",
          completedAt: "2026-06-18T00:00:02Z",
          errorReason: null,
        },
      ],
    });
    expect(md).toContain("# Swarm log");
    expect(md).toContain("`fan_1`");
    expect(md).toContain("search_web — completed");
    expect(md).toContain("**Query:** USS Nautilus crew");
    expect(md).toContain("[Crew roster](https://x/crew)");
    expect(md).toContain("The first crew served under Wilkinson.");
    expect(md).toContain("2000ms"); // duration from the timeline
  });

  it("fences non-search output and surfaces errors", () => {
    const md = buildLogMarkdown({
      title: "t",
      fanoutId: "f",
      status: "partial",
      children: [
        {
          runId: "r2",
          capabilityName: "query_ontology",
          status: "failed",
          summary: "failed",
          input: { startNodeId: "X" },
          output: null,
          outputBytes: 0,
          errorReason: "neo4j down",
        },
      ],
      timeline: [],
    });
    expect(md).toContain("query_ontology — failed");
    expect(md).toContain("**Error:** neo4j down");
    expect(md).toContain("```json");
  });
});

describe("agentSubagentLogsHandler", () => {
  afterEach(() => {
    invoke.mockReset();
    persistGeneratedAsset.mockReset();
  });

  it("aggregates children, writes a markdown document asset, returns a file-attachment render", async () => {
    invoke.mockResolvedValue({
      fanoutId: "fan_1",
      status: "completed",
      totalChildren: 1,
      completedChildren: 1,
      aggregatedData: {},
      conflicts: [],
      timeline: [],
      children: [webChild],
      firstError: null,
    });
    persistGeneratedAsset.mockResolvedValue({
      id: "ast_1",
      publicId: "gen_1",
      kind: "document",
      mimeType: "text/markdown",
      sizeBytes: 512,
      url: "blob://x",
      serveUrl: "/api/v1/assets/gen_1",
    });

    const out = await agentSubagentLogsHandler(
      { fanoutId: "fan_1", title: "Nautilus swarm" },
      ctx,
    );

    expect(out.childCount).toBe(1);
    expect(out.render.componentId).toBe("file-attachment");
    expect(out.render.props.kind).toBe("document");
    expect(out.render.props.name).toBe("nautilus-swarm.md");
    expect(out.serveUrl).toBe("/api/v1/assets/gen_1");

    // The persisted bytes are the markdown log (contains the query).
    const persistArg = persistGeneratedAsset.mock.calls[0]?.[0] as {
      mimeType: string;
      bytes: Uint8Array;
      kind: string;
    };
    expect(persistArg.mimeType).toBe("text/markdown");
    expect(persistArg.kind).toBe("document");
    expect(new TextDecoder().decode(persistArg.bytes)).toContain(
      "USS Nautilus crew",
    );
  });

  it("requires a user identity", async () => {
    await expect(
      agentSubagentLogsHandler({ fanoutId: "fan_1" }, { ...ctx, userId: null }),
    ).rejects.toThrow(/userId is required/);
  });
});
