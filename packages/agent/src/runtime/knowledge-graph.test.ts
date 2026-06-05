import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isKnowledgeGraphEnabled, readWorkspaceContext, injectContext } from "./knowledge-graph";
import type { ContextBlock } from "./knowledge-graph";
import type { ModelMessage } from "ai";

// Store original env vars so we can restore them after each test.
const ORIGINAL_NEO4J_URI = process.env.NEO4J_URI;
const ORIGINAL_KG_FLAG = process.env.KNOWLEDGE_GRAPH_ENABLED;

beforeEach(() => {
  // Start each test in the disabled state by default.
  delete process.env.NEO4J_URI;
  delete process.env.KNOWLEDGE_GRAPH_ENABLED;
});

afterEach(() => {
  // Restore original values so tests don't pollute each other.
  if (ORIGINAL_NEO4J_URI !== undefined) {
    process.env.NEO4J_URI = ORIGINAL_NEO4J_URI;
  } else {
    delete process.env.NEO4J_URI;
  }
  if (ORIGINAL_KG_FLAG !== undefined) {
    process.env.KNOWLEDGE_GRAPH_ENABLED = ORIGINAL_KG_FLAG;
  } else {
    delete process.env.KNOWLEDGE_GRAPH_ENABLED;
  }
});

describe("isKnowledgeGraphEnabled", () => {
  it("returns false when NEO4J_URI is absent", () => {
    delete process.env.NEO4J_URI;
    expect(isKnowledgeGraphEnabled()).toBe(false);
  });

  it("returns false when NEO4J_URI is an empty string", () => {
    process.env.NEO4J_URI = "";
    expect(isKnowledgeGraphEnabled()).toBe(false);
  });

  it("returns false when KNOWLEDGE_GRAPH_ENABLED is 'false' even if NEO4J_URI is set", () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    process.env.KNOWLEDGE_GRAPH_ENABLED = "false";
    expect(isKnowledgeGraphEnabled()).toBe(false);
  });

  it("returns true when NEO4J_URI is set and the flag is not explicitly false", () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    expect(isKnowledgeGraphEnabled()).toBe(true);
  });

  it("returns true when NEO4J_URI is set and KNOWLEDGE_GRAPH_ENABLED is 'true'", () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
    expect(isKnowledgeGraphEnabled()).toBe(true);
  });
});

describe("readWorkspaceContext", () => {
  const ctx = { orgId: "ten_1", workspaceId: "ws_1", userId: "u_1" };

  it("returns [] when knowledge graph is disabled (no NEO4J_URI)", async () => {
    const blocks = await readWorkspaceContext(ctx);
    expect(blocks).toEqual([]);
  });

  it("returns [] when KNOWLEDGE_GRAPH_ENABLED is 'false'", async () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    process.env.KNOWLEDGE_GRAPH_ENABLED = "false";
    const blocks = await readWorkspaceContext(ctx);
    expect(blocks).toEqual([]);
  });

  it("returns [] when enabled but workspace-context query is not yet wired (OXA-1508)", async () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    const blocks = await readWorkspaceContext(ctx);
    expect(blocks).toEqual([]);
  });

  it("accepts null userId without throwing", async () => {
    await expect(readWorkspaceContext({ orgId: "ten_1", workspaceId: "ws_1", userId: null })).resolves.toEqual([]);
  });
});

describe("injectContext", () => {
  const userMsg: ModelMessage = { role: "user", content: "hello" };

  it("returns messages unchanged when blocks is empty", () => {
    const messages: ModelMessage[] = [userMsg];
    const result = injectContext(messages, []);
    // Must be the SAME reference as the input array — true no-op, zero allocation.
    expect(result).toBe(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(userMsg);
  });

  it("prepends a system message when blocks is non-empty", () => {
    const blocks: ContextBlock[] = [
      { source: "wiki", text: "some context" },
      { source: "graph", text: "more context" },
    ];
    const result = injectContext([userMsg], blocks);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("system");
    expect(result[1]).toEqual(userMsg);
    const systemContent = result[0]!.content as string;
    expect(systemContent).toContain("[wiki]");
    expect(systemContent).toContain("some context");
    expect(systemContent).toContain("[graph]");
    expect(systemContent).toContain("more context");
  });

  it("leaves the original messages array unmodified", () => {
    const messages: ModelMessage[] = [userMsg];
    const blocks: ContextBlock[] = [{ source: "src", text: "ctx" }];
    const result = injectContext(messages, blocks);
    // Original array must be untouched (injectContext returns a new array).
    expect(messages).toHaveLength(1);
    expect(result).toHaveLength(2);
  });
});
