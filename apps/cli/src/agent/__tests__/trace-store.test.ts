/**
 * Turn-trace store — proves traces persist newest-first, dedupe by id, stay
 * bounded, and that `resolve` maps an empty arg / recency index / id / id-prefix
 * to the right trace. Storage is redirected to a temp HOME so the real config
 * directory is never touched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { rmSync } from "node:fs";

const { TEST_HOME } = vi.hoisted(() => {
  // vi.hoisted is lifted above every ESM import, so this factory cannot see the
  // file's `import` bindings — and it must create the temp HOME synchronously,
  // before the node:os mock below closes over it. require is the only way to
  // reach the node builtins here; an async factory would make TEST_HOME a
  // Promise and break both the sync homedir mock and the afterAll cleanup.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
  const path = require("node:path") as typeof import("node:path");
  return { TEST_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "oxagen-trace-")) };
});

vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

import { openTraceStore } from "../trace-store.js";
import type { TurnTrace } from "../trace.js";

function trace(id: string, prompt = "do a thing"): TurnTrace {
  return {
    id,
    createdAt: 1,
    cwd: "/x",
    originalPrompt: prompt,
    evaluation: {
      completeness: 50,
      complexity: 50,
      recommendedTier: "fast",
      missing: [],
      contextQueries: [],
      refinedPrompt: prompt,
      removed: [],
      reasoning: "",
      fallback: false,
      model: "m",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    },
    enhancement: { prompt, context: "", lessonCount: 0, source: "none" },
    selectedModel: "anthropic/claude-sonnet-5",
    selectedTier: "balanced",
    selectionRationale: "test",
    response: "ok",
    filesTouched: [],
    commandsRun: [],
    judgeRounds: [],
    finalComplete: true,
    steps: 1,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    durationMs: 10,
  };
}

const cwd = "/tmp/proj-trace-store-test";

beforeEach(() => {
  rmSync(`${TEST_HOME}/.config/oxagen/traces/${"proj-trace-store-test"}.json`, {
    force: true,
  });
});

describe("openTraceStore", () => {
  it("records newest-first and reads back", () => {
    const store = openTraceStore(cwd);
    store.record(trace("a"));
    store.record(trace("b"));
    const list = store.list();
    expect(list.map((t) => t.id)).toEqual(["b", "a"]);
    expect(store.last()?.id).toBe("b");
    expect(store.get("a")?.id).toBe("a");
  });

  it("dedupes by id (re-record updates in place)", () => {
    const store = openTraceStore(cwd);
    store.record(trace("a", "first"));
    store.record(trace("a", "second"));
    expect(store.list()).toHaveLength(1);
    expect(store.get("a")?.originalPrompt).toBe("second");
  });

  it("bounds history to the most recent 100", () => {
    const store = openTraceStore(cwd);
    for (let i = 0; i < 105; i++) store.record(trace(`t${i}`));
    const list = store.list();
    expect(list).toHaveLength(100);
    expect(list[0]?.id).toBe("t104");
  });

  it("resolves empty arg to the most recent", () => {
    const store = openTraceStore(cwd);
    store.record(trace("a"));
    store.record(trace("b"));
    expect(store.resolve("")?.id).toBe("b");
  });

  it("resolves a 1-based recency index", () => {
    const store = openTraceStore(cwd);
    store.record(trace("a"));
    store.record(trace("b"));
    expect(store.resolve("1")?.id).toBe("b");
    expect(store.resolve("2")?.id).toBe("a");
    expect(store.resolve("9")).toBeUndefined();
  });

  it("resolves by exact id and id prefix", () => {
    const store = openTraceStore(cwd);
    store.record(trace("turn_abcdef"));
    expect(store.resolve("turn_abcdef")?.id).toBe("turn_abcdef");
    expect(store.resolve("turn_abc")?.id).toBe("turn_abcdef");
    expect(store.resolve("nope")).toBeUndefined();
  });

  it("returns empty results before anything is recorded", () => {
    const store = openTraceStore("/tmp/proj-empty-xyz");
    expect(store.list()).toEqual([]);
    expect(store.last()).toBeUndefined();
    expect(store.resolve("")).toBeUndefined();
  });
});
