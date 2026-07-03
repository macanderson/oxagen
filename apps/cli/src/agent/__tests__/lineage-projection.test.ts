/**
 * lineage-projection.ts unit tests.
 *
 * Verifies:
 *   - All expected nodes are emitted for a standard TurnTrace
 *   - File nodes carry `code:{repo}:{path}` keys (linkage to code subgraph)
 *   - Tool-event nodes are emitted only when `toolEvents` is present (verbose)
 *   - Idempotent keys — deterministic per turn id
 *   - No SourceFile nodes when `repo` is omitted
 *   - mergeEnvelopes deduplicates nodes across traces sharing a model
 */

import { describe, it, expect } from "vitest";
import {
  projectTrace,
  mergeEnvelopes,
  sessionNodeKey,
  turnNodeKey,
  toolNodeKey,
  modelNodeKey,
  fileNodeKey,
} from "../lineage-projection.js";
import type { TurnTrace } from "../trace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurnTrace(overrides: Partial<TurnTrace> = {}): TurnTrace {
  return {
    id: "turn-abc123",
    createdAt: 1_700_000_000_000,
    cwd: "/projects/my-app",
    originalPrompt: "Fix the login bug",
    evaluation: {
      completeness: 90,
      complexity: 40,
      recommendedTier: "balanced",
      missing: [],
      contextQueries: [],
      refinedPrompt: "Fix the login bug",
      removed: [],
      reasoning: "direct",
      fallback: false,
      model: "claude-haiku-4",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
    },
    enhancement: {
      prompt: "Fix the login bug",
      context: "",
      resolved: [],
      lessonCount: 0,
      source: "none",
    },
    selectedModel: "claude-sonnet-5",
    selectedTier: "balanced",
    selectionRationale: "complexity=40",
    response: "I fixed the bug.",
    filesTouched: ["src/auth/login.ts", "src/auth/session.ts"],
    commandsRun: [],
    judgeRounds: [],
    finalComplete: true,
    steps: 3,
    usage: {
      inputTokens: 1200,
      outputTokens: 800,
      costUsd: 0.01,
    },
    durationMs: 5000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

describe("key builders", () => {
  it("sessionNodeKey has correct prefix", () => {
    expect(sessionNodeKey("my-app")).toBe("lineage:session:my-app");
  });

  it("turnNodeKey has correct prefix", () => {
    expect(turnNodeKey("abc123")).toBe("lineage:turn:abc123");
  });

  it("toolNodeKey encodes turn id + index", () => {
    expect(toolNodeKey("abc123", 2)).toBe("lineage:tool:abc123:2");
  });

  it("modelNodeKey has correct prefix", () => {
    expect(modelNodeKey("claude-sonnet-5")).toBe("lineage:model:claude-sonnet-5");
  });

  it("fileNodeKey matches code-push scheme", () => {
    expect(fileNodeKey("https://github.com/org/repo.git", "src/auth/login.ts"))
      .toBe("code:https://github.com/org/repo.git:src/auth/login.ts");
  });
});

// ---------------------------------------------------------------------------
// projectTrace — standard non-verbose trace
// ---------------------------------------------------------------------------

describe("projectTrace — standard (non-verbose) trace", () => {
  const trace = makeTurnTrace();
  const repo = "https://github.com/org/repo.git";
  const envelope = projectTrace(trace, { repo });

  it("emits a session node", () => {
    const n = envelope.nodes.find((n) => n.key === sessionNodeKey("my-app"));
    expect(n).toBeDefined();
    expect(n!.labels).toContain("AgentSession");
    expect(n!.isSystem).toBe(true);
  });

  it("emits a turn node with correct properties", () => {
    const n = envelope.nodes.find((n) => n.key === turnNodeKey("turn-abc123"));
    expect(n).toBeDefined();
    expect(n!.labels).toContain("AgentTurn");
    expect(n!.properties["turnId"]).toBe("turn-abc123");
    expect(n!.properties["selectedModel"]).toBe("claude-sonnet-5");
    expect(n!.properties["inputTokens"]).toBe(1200);
    expect(n!.properties["outputTokens"]).toBe(800);
    expect(n!.properties["durationMs"]).toBe(5000);
    expect(n!.properties["finalComplete"]).toBe(true);
    expect(n!.isSystem).toBe(true);
  });

  it("emits a model node", () => {
    const n = envelope.nodes.find((n) => n.key === modelNodeKey("claude-sonnet-5"));
    expect(n).toBeDefined();
    expect(n!.labels).toContain("AIModel");
    expect(n!.properties["slug"]).toBe("claude-sonnet-5");
    expect(n!.isSystem).toBe(true);
  });

  it("emits SourceFile nodes for each filesTouched, keyed code:{repo}:{path}", () => {
    const loginKey = fileNodeKey(repo, "src/auth/login.ts");
    const sessionKey = fileNodeKey(repo, "src/auth/session.ts");

    const loginNode = envelope.nodes.find((n) => n.key === loginKey);
    const sessionNode = envelope.nodes.find((n) => n.key === sessionKey);

    expect(loginNode).toBeDefined();
    expect(loginNode!.labels).toContain("SourceFile");
    expect(loginNode!.isSystem).toBe(true);

    expect(sessionNode).toBeDefined();
    expect(sessionNode!.labels).toContain("SourceFile");
  });

  it("emits HAS_TURN edge from session to turn", () => {
    const e = envelope.edges.find(
      (e) => e.sourceKey === sessionNodeKey("my-app") &&
              e.targetKey === turnNodeKey("turn-abc123") &&
              e.type === "HAS_TURN",
    );
    expect(e).toBeDefined();
  });

  it("emits USED_MODEL edge from turn to model", () => {
    const e = envelope.edges.find(
      (e) => e.sourceKey === turnNodeKey("turn-abc123") &&
              e.targetKey === modelNodeKey("claude-sonnet-5") &&
              e.type === "USED_MODEL",
    );
    expect(e).toBeDefined();
  });

  it("emits TOUCHED_FILE edges for each filesTouched", () => {
    const files = ["src/auth/login.ts", "src/auth/session.ts"];
    for (const path of files) {
      const e = envelope.edges.find(
        (e) => e.sourceKey === turnNodeKey("turn-abc123") &&
                e.targetKey === fileNodeKey(repo, path) &&
                e.type === "TOUCHED_FILE",
      );
      expect(e, `expected TOUCHED_FILE edge for ${path}`).toBeDefined();
    }
  });

  it("does not emit any AgentToolCall nodes (no toolEvents)", () => {
    const toolNodes = envelope.nodes.filter((n) => n.labels.includes("AgentToolCall"));
    expect(toolNodes).toHaveLength(0);
  });

  it("does not emit USED_TOOL edges (no toolEvents)", () => {
    const toolEdges = envelope.edges.filter((e) => e.type === "USED_TOOL");
    expect(toolEdges).toHaveLength(0);
  });

  it("all nodes have isSystem = true", () => {
    for (const n of envelope.nodes) {
      expect(n.isSystem, `node ${n.key} should have isSystem=true`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// projectTrace — verbose trace with toolEvents
// ---------------------------------------------------------------------------

describe("projectTrace — verbose trace with toolEvents", () => {
  const trace = makeTurnTrace({
    verbose: true,
    toolEvents: [
      { name: "Read", input: '{"path":"src/auth/login.ts"}', durationMs: 120, ok: true, startedAt: 1_700_000_000_000, finishedAt: 1_700_000_000_120 },
      { name: "Edit", input: '{"path":"src/auth/login.ts"}', durationMs: 80, ok: true, startedAt: 1_700_000_000_120, finishedAt: 1_700_000_000_200 },
    ],
  });
  const envelope = projectTrace(trace, { repo: "https://github.com/org/repo.git" });

  it("emits AgentToolCall nodes for each tool event", () => {
    const toolNodes = envelope.nodes.filter((n) => n.labels.includes("AgentToolCall"));
    expect(toolNodes).toHaveLength(2);
  });

  it("tool node keys encode turn id and index", () => {
    const k0 = toolNodeKey("turn-abc123", 0);
    const k1 = toolNodeKey("turn-abc123", 1);
    expect(envelope.nodes.find((n) => n.key === k0)).toBeDefined();
    expect(envelope.nodes.find((n) => n.key === k1)).toBeDefined();
  });

  it("tool nodes carry correct properties", () => {
    const n = envelope.nodes.find((n) => n.key === toolNodeKey("turn-abc123", 0))!;
    expect(n.displayName).toBe("Read");
    expect(n.properties["name"]).toBe("Read");
    expect(n.properties["durationMs"]).toBe(120);
    expect(n.properties["ok"]).toBe(true);
    expect(n.isSystem).toBe(true);
  });

  it("emits USED_TOOL edges from turn to each tool node", () => {
    for (let idx = 0; idx < 2; idx++) {
      const e = envelope.edges.find(
        (e) => e.sourceKey === turnNodeKey("turn-abc123") &&
                e.targetKey === toolNodeKey("turn-abc123", idx) &&
                e.type === "USED_TOOL",
      );
      expect(e, `USED_TOOL edge for index ${idx}`).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// projectTrace — no repo provided
// ---------------------------------------------------------------------------

describe("projectTrace — without repo", () => {
  it("emits no SourceFile nodes when repo is absent", () => {
    const trace = makeTurnTrace({ filesTouched: ["src/foo.ts"] });
    const envelope = projectTrace(trace, {}); // no repo

    const fileNodes = envelope.nodes.filter((n) => n.labels.includes("SourceFile"));
    expect(fileNodes).toHaveLength(0);
  });

  it("emits no TOUCHED_FILE edges when repo is absent", () => {
    const trace = makeTurnTrace({ filesTouched: ["src/foo.ts"] });
    const envelope = projectTrace(trace, {});

    const touchedEdges = envelope.edges.filter((e) => e.type === "TOUCHED_FILE");
    expect(touchedEdges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// projectTrace — empty filesTouched
// ---------------------------------------------------------------------------

describe("projectTrace — empty filesTouched", () => {
  it("handles an empty filesTouched array without error", () => {
    const trace = makeTurnTrace({ filesTouched: [] });
    const envelope = projectTrace(trace, { repo: "https://github.com/org/repo.git" });
    const fileNodes = envelope.nodes.filter((n) => n.labels.includes("SourceFile"));
    expect(fileNodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// projectTrace — sessionKey derivation from cwd
// ---------------------------------------------------------------------------

describe("projectTrace — sessionKey from cwd", () => {
  it("derives session key from basename of cwd", () => {
    const trace = makeTurnTrace({ cwd: "/home/user/projects/my-awesome-app" });
    const envelope = projectTrace(trace);
    const sessionNode = envelope.nodes.find((n) => n.labels.includes("AgentSession"));
    expect(sessionNode).toBeDefined();
    expect(sessionNode!.key).toBe("lineage:session:my-awesome-app");
  });

  it("accepts an explicit sessionKey override", () => {
    const trace = makeTurnTrace({ cwd: "/any/path" });
    const envelope = projectTrace(trace, { sessionKey: "custom-session" });
    const sessionNode = envelope.nodes.find((n) => n.labels.includes("AgentSession"));
    expect(sessionNode!.key).toBe("lineage:session:custom-session");
  });
});

// ---------------------------------------------------------------------------
// mergeEnvelopes — deduplication across traces
// ---------------------------------------------------------------------------

describe("mergeEnvelopes", () => {
  it("deduplicates session and model nodes shared across traces", () => {
    const trace1 = makeTurnTrace({ id: "turn-1", cwd: "/projects/my-app" });
    const trace2 = makeTurnTrace({ id: "turn-2", cwd: "/projects/my-app" });

    const env1 = projectTrace(trace1);
    const env2 = projectTrace(trace2);
    const merged = mergeEnvelopes([env1, env2]);

    // Should have exactly one session node
    const sessionNodes = merged.nodes.filter((n) => n.labels.includes("AgentSession"));
    expect(sessionNodes).toHaveLength(1);

    // Should have exactly one model node (both traces use the same model)
    const modelNodes = merged.nodes.filter((n) => n.labels.includes("AIModel"));
    expect(modelNodes).toHaveLength(1);

    // Should have two turn nodes
    const turnNodes = merged.nodes.filter((n) => n.labels.includes("AgentTurn"));
    expect(turnNodes).toHaveLength(2);
  });

  it("keeps all edges from both traces", () => {
    const trace1 = makeTurnTrace({ id: "turn-1" });
    const trace2 = makeTurnTrace({ id: "turn-2" });

    const merged = mergeEnvelopes([
      projectTrace(trace1),
      projectTrace(trace2),
    ]);

    // Each trace contributes HAS_TURN and USED_MODEL edges
    const hasTurn = merged.edges.filter((e) => e.type === "HAS_TURN");
    expect(hasTurn).toHaveLength(2);
  });

  it("handles an empty input array", () => {
    const merged = mergeEnvelopes([]);
    expect(merged.nodes).toHaveLength(0);
    expect(merged.edges).toHaveLength(0);
  });

  it("handles a single envelope unchanged", () => {
    const trace = makeTurnTrace();
    const env = projectTrace(trace);
    const merged = mergeEnvelopes([env]);
    expect(merged.nodes).toHaveLength(env.nodes.length);
    expect(merged.edges).toHaveLength(env.edges.length);
  });

  it("deduplicates SourceFile nodes shared across traces", () => {
    const repo = "https://github.com/org/repo.git";
    const trace1 = makeTurnTrace({ id: "turn-1", filesTouched: ["src/foo.ts"] });
    const trace2 = makeTurnTrace({ id: "turn-2", filesTouched: ["src/foo.ts"] });

    const merged = mergeEnvelopes([
      projectTrace(trace1, { repo }),
      projectTrace(trace2, { repo }),
    ]);

    const fileNodes = merged.nodes.filter((n) => n.labels.includes("SourceFile"));
    expect(fileNodes).toHaveLength(1);
  });
});
