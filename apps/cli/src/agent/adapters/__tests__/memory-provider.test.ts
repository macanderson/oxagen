import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock the transport-backed client so createServerMemory can be tested without a
// network, and so createCombinedMemory tests never touch config/HTTP.
const { recallMemories, rememberMemory } = vi.hoisted(() => ({
  recallMemories: vi.fn(),
  rememberMemory: vi.fn(),
}));
vi.mock("../../../lib/memory-client.js", () => ({
  recallMemories,
  rememberMemory,
}));

// Mock the CLI debug channel so the non-blocking failure paths can be asserted
// (a dropped remember/recall must log, not silently swallow).
const { debugLog } = vi.hoisted(() => ({
  debugLog: vi.fn(async () => undefined),
}));
vi.mock("../../../lib/debug-log.js", () => ({ debugLog }));

import {
  createCombinedMemory,
  createServerMemory,
  formatServerMemories,
  type ServerMemory,
} from "../memory-provider.js";
import type { SessionMemory } from "../../memory.js";
import type { FleetMemory, MemoryRecord } from "../../fleet/memory.js";
import type { RecalledMemory } from "../../../lib/memory-client.js";

function recalled(over: Partial<RecalledMemory>): RecalledMemory {
  return {
    id: "m",
    nodeRef: "coding-agent",
    memoryClass: "OBSERVATION",
    memoryKind: "gotcha",
    lesson: "a lesson",
    source: "fix",
    confidenceScore: 50,
    enforcementScore: null,
    score: 0.7,
    createdAt: "2026-07-01T00:00:00Z",
    ...over,
  };
}

function fakeSession(tail: string): SessionMemory {
  return {
    recallContext: vi.fn().mockResolvedValue(tail),
    remember: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionMemory;
}

function fakeFleet(): FleetMemory {
  return {
    record: vi.fn(),
    recall: vi.fn().mockReturnValue([]),
    all: vi.fn().mockReturnValue([] as MemoryRecord[]),
  };
}

const ORIGINAL_DISABLE = process.env["OXAGEN_DISABLE_MEMORY"];

afterEach(() => {
  if (ORIGINAL_DISABLE === undefined)
    delete process.env["OXAGEN_DISABLE_MEMORY"];
  else process.env["OXAGEN_DISABLE_MEMORY"] = ORIGINAL_DISABLE;
  vi.useRealTimers();
});

describe("formatServerMemories", () => {
  it("orders FACT and RULE ahead of OBSERVATION and renders class/kind + confidence", () => {
    const out = formatServerMemories([
      recalled({
        id: "o",
        memoryClass: "OBSERVATION",
        lesson: "obs",
        confidenceScore: 40,
      }),
      recalled({
        id: "r",
        memoryClass: "RULE",
        memoryKind: "constraint",
        lesson: "rule",
        confidenceScore: 88,
      }),
      recalled({
        id: "f",
        memoryClass: "FACT",
        memoryKind: "gotcha",
        lesson: "fact",
        confidenceScore: 99,
      }),
    ]);
    expect(out).toContain("## Lessons from prior sessions (workspace memory)");
    const factLine = out.indexOf("fact");
    const ruleLine = out.indexOf("rule");
    const obsLine = out.indexOf("obs");
    expect(factLine).toBeLessThan(ruleLine);
    expect(ruleLine).toBeLessThan(obsLine);
    expect(out).toContain("[RULE/constraint] rule (confidence 88)");
  });

  it("deduplicates identical lessons and returns empty string for no rows", () => {
    expect(formatServerMemories([])).toBe("");
    const out = formatServerMemories([
      recalled({ id: "1", lesson: "Same lesson" }),
      recalled({ id: "2", lesson: "same lesson" }),
    ]);
    const rows = out.split("\n").filter((l) => l.startsWith("- "));
    expect(rows).toHaveLength(1);
  });
});

describe("createCombinedMemory.recallContext", () => {
  it("merges the session tail with the server lessons section", async () => {
    const server: ServerMemory = {
      recall: vi
        .fn()
        .mockResolvedValue([
          recalled({ memoryClass: "RULE", lesson: "server rule" }),
        ]),
      remember: vi.fn(),
    };
    const mem = createCombinedMemory(
      fakeSession("recent activity"),
      fakeFleet(),
      {
        server,
        recallQuery: "do a task",
      },
    );
    const out = await mem.recallContext();
    expect(out).toContain("recent activity");
    expect(out).toContain("## Lessons from prior sessions");
    expect(out).toContain("server rule");
    expect(server.recall).toHaveBeenCalledWith("do a task");
  });

  it("falls back to local-only when the server recall rejects", async () => {
    const server: ServerMemory = {
      recall: vi.fn().mockRejectedValue(new Error("network down")),
      remember: vi.fn(),
    };
    const mem = createCombinedMemory(fakeSession("local tail"), fakeFleet(), {
      server,
      recallQuery: "task",
    });
    const out = await mem.recallContext();
    expect(out).toBe("local tail");
  });

  it("logs on the debug channel and degrades when the session recall rejects", async () => {
    debugLog.mockClear();
    const session = {
      recallContext: vi.fn().mockRejectedValue(new Error("duckdb closed")),
      remember: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionMemory;
    const mem = createCombinedMemory(session, fakeFleet());
    // No throw — degrades to an empty session tail.
    const out = await mem.recallContext();
    expect(out).toBe("");
    expect(debugLog).toHaveBeenCalledWith(
      "error",
      "memory.recall-failed",
      expect.objectContaining({
        message: expect.stringContaining("duckdb closed"),
      }),
    );
  });

  it("falls back to local-only when the server recall exceeds the timeout", async () => {
    vi.useFakeTimers();
    const server: ServerMemory = {
      recall: vi.fn().mockReturnValue(new Promise<RecalledMemory[]>(() => {})), // never resolves
      remember: vi.fn(),
    };
    const mem = createCombinedMemory(fakeSession("local tail"), fakeFleet(), {
      server,
      recallQuery: "task",
      serverTimeoutMs: 100,
    });
    const p = mem.recallContext();
    await vi.advanceTimersByTimeAsync(150);
    expect(await p).toBe("local tail");
  });

  it("skips the server entirely when OXAGEN_DISABLE_MEMORY=1", async () => {
    process.env["OXAGEN_DISABLE_MEMORY"] = "1";
    const server: ServerMemory = { recall: vi.fn(), remember: vi.fn() };
    const mem = createCombinedMemory(fakeSession("tail"), fakeFleet(), {
      server,
      recallQuery: "task",
    });
    const out = await mem.recallContext();
    expect(server.recall).not.toHaveBeenCalled();
    expect(out).toBe("tail");
  });

  it("returns just the session tail when no server handle is injected (logged-out)", async () => {
    const mem = createCombinedMemory(fakeSession("only local"), fakeFleet());
    expect(await mem.recallContext()).toBe("only local");
  });
});

describe("createCombinedMemory.remember", () => {
  beforeEach(() => {
    recallMemories.mockReset();
    rememberMemory.mockReset();
  });

  it("mirrors high-signal lesson kinds to the server but not noisy episodic kinds", () => {
    const server: ServerMemory = { recall: vi.fn(), remember: vi.fn() };
    const mem = createCombinedMemory(fakeSession(""), fakeFleet(), { server });

    mem.remember("gotcha", { lesson: "a gotcha" });
    mem.remember("bug-root-cause", { lesson: "root cause" });
    mem.remember("convention-deviation", { lesson: "deviation" });
    mem.remember("routine-change", { lesson: "routine" });
    // Noise — must NOT reach the server.
    mem.remember("user_prompt", "hello");
    mem.remember("tool_call", { name: "bash" });
    mem.remember("assistant_reply", "done");
    mem.remember("coding_turn", { text: "…" });

    expect(
      (server.remember as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]),
    ).toEqual([
      "gotcha",
      "bug-root-cause",
      "convention-deviation",
      "routine-change",
    ]);
  });

  it("does not call the server when OXAGEN_DISABLE_MEMORY=1", () => {
    process.env["OXAGEN_DISABLE_MEMORY"] = "1";
    const server: ServerMemory = { recall: vi.fn(), remember: vi.fn() };
    const mem = createCombinedMemory(fakeSession(""), fakeFleet(), { server });
    mem.remember("gotcha", { lesson: "x" });
    expect(server.remember).not.toHaveBeenCalled();
  });
});

describe("createServerMemory", () => {
  beforeEach(() => {
    recallMemories.mockReset();
    rememberMemory.mockReset();
    recallMemories.mockResolvedValue({ memories: [] });
    rememberMemory.mockResolvedValue({});
  });

  it("recall passes the executionRef + agentId so results are auto-cited", async () => {
    const server = createServerMemory({
      agentId: "coding-agent",
      executionRef: "cli:repl-1",
      recallLimit: 4,
    });
    await server.recall("query text");
    expect(recallMemories).toHaveBeenCalledWith({
      query: "query text",
      limit: 4,
      executionRef: "cli:repl-1",
      agentId: "coding-agent",
    });
  });

  it("remember enriches the lesson with project + files and forwards the kind", async () => {
    const server = createServerMemory({ projectName: "oxagen-platform" });
    server.remember("bug-root-cause", {
      lesson: "raw body parsed before signature check",
      files: ["apps/api/src/routes/v1/billing-webhook.ts"],
    });
    // Fire-and-forget — let the microtask settle.
    await Promise.resolve();
    expect(rememberMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryKind: "bug-root-cause",
        source: "fix",
        text: expect.stringContaining("[oxagen-platform]"),
      }),
    );
    const call = rememberMemory.mock.calls[0]![0] as { text: string };
    expect(call.text).toContain("raw body parsed before signature check");
    expect(call.text).toContain("billing-webhook.ts");
  });

  it("remember skips empty lessons", () => {
    const server = createServerMemory({});
    server.remember("gotcha", { lesson: "   " });
    expect(rememberMemory).not.toHaveBeenCalled();
  });

  it("remember logs on the debug channel when the mirror rejects (fire-and-forget)", async () => {
    debugLog.mockClear();
    rememberMemory.mockRejectedValueOnce(new Error("api unreachable"));
    const server = createServerMemory({ projectName: "oxagen-platform" });
    server.remember("gotcha", { lesson: "a durable lesson" });
    // Fire-and-forget — let the rejection settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(debugLog).toHaveBeenCalledWith(
      "error",
      "memory.remember-failed",
      expect.objectContaining({
        message: expect.stringContaining("api unreachable"),
      }),
    );
  });
});
