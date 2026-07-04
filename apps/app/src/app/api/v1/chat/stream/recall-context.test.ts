/**
 * recall-context.test.ts — unit tests for the deterministic memory-recall
 * injection used by the chat stream route.
 *
 * Covers:
 *   (a) recallWorkspaceMemory invokes agent.memory.recall with the latest user
 *       text (truncated), a bounded limit, and the turn's executionRef, and
 *       returns a volatile user message carrying the recalled lessons.
 *   (b) recall failure / empty result / timeout → null (turn proceeds untouched).
 *   (c) injectRecalledMemory places the message immediately before the latest
 *       user message, and is a no-op when there is nothing to inject.
 *   (d) formatRecalledMemories renders RULE enforcement and returns null on empty.
 */

import { describe, it, expect, vi } from "vitest";
import type { ModelMessage } from "@oxagen/ai";
import type { CapabilityContext } from "@oxagen/oxagen";
import { agentMemoryRecall } from "@oxagen/oxagen/contracts/agent.memory.recall";
import {
  formatRecalledMemories,
  buildRecalledMemoryMessage,
  recallWorkspaceMemory,
  injectRecalledMemory,
  stripRecalledMemoryHeading,
} from "./recall-context";

type RecalledMemory = Parameters<typeof formatRecalledMemories>[0][number];

function memory(overrides: Partial<RecalledMemory> = {}): RecalledMemory {
  return {
    id: "m-1",
    nodeRef: "node-1",
    memoryClass: "OBSERVATION",
    memoryKind: "bug",
    lesson: "The Stripe webhook tunnel secret rotates per dev session.",
    source: "session",
    confidenceScore: 80,
    enforcementScore: null,
    score: 0.9,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

const CTX: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  apiKeyId: null,
  requestId: "req-1",
  surface: "app",
  messageId: "msg-1",
  clientIp: null,
} as CapabilityContext;

function userMsg(content: string): ModelMessage {
  return { role: "user", content };
}

describe("formatRecalledMemories", () => {
  it("returns null when there are no memories (no empty section)", () => {
    expect(formatRecalledMemories([])).toBeNull();
  });

  it("renders one bullet per memory with class·kind tag", () => {
    const body = formatRecalledMemories([
      memory({ memoryClass: "OBSERVATION", memoryKind: "bug", lesson: "A" }),
    ]);
    expect(body).toContain("## Recalled workspace memory (prior sessions)");
    expect(body).toContain("- [OBSERVATION·bug] A");
    expect(body).toContain("never violate a RULE");
  });

  it("annotates RULE memories with their enforcement score", () => {
    const body = formatRecalledMemories([
      memory({ memoryClass: "RULE", memoryKind: "convention", lesson: "Use withTenantDb", enforcementScore: 90 }),
    ]);
    expect(body).toContain("- [RULE·convention] Use withTenantDb (enforcement 90)");
  });

  it("collapses whitespace in multi-line lessons onto one bullet", () => {
    const body = formatRecalledMemories([
      memory({ lesson: "line one\n   line two" }),
    ]);
    expect(body).toContain("line one line two");
    expect(body).not.toContain("line one\n");
  });
});

describe("stripRecalledMemoryHeading", () => {
  it("drops the leading ## heading and following blank lines, keeps the preamble", () => {
    const body = formatRecalledMemories([memory({ lesson: "use strict types" })]);
    expect(body).not.toBeNull();
    const stripped = stripRecalledMemoryHeading(body as string);
    // The engine adds its own heading, so ours must be gone…
    expect(stripped.startsWith("## ")).toBe(false);
    expect(stripped).not.toContain("Recalled workspace memory");
    // …but the anti-injection preamble and bullets stay.
    expect(stripped.startsWith("(System-injected context")).toBe(true);
    expect(stripped).toContain("use strict types");
  });

  it("returns the body unchanged when there is no leading heading", () => {
    expect(stripRecalledMemoryHeading("- just a bullet")).toBe("- just a bullet");
  });
});

describe("buildRecalledMemoryMessage", () => {
  it("returns null when empty", () => {
    expect(buildRecalledMemoryMessage([])).toBeNull();
  });

  it("returns a user-role message when memories exist", () => {
    const msg = buildRecalledMemoryMessage([memory()]);
    expect(msg).not.toBeNull();
    expect(msg?.role).toBe("user");
    expect(String(msg?.content)).toContain("Recalled workspace memory");
  });
});

describe("recallWorkspaceMemory", () => {
  it("invokes agent.memory.recall with the latest user text, a bounded limit, and executionRef", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ memories: [memory({ lesson: "Prior lesson" })] });

    const msg = await recallWorkspaceMemory({
      query: "why did the deploy fail?",
      executionRef: "exec-42",
      ctx: CTX,
      invokeFn,
    });

    expect(invokeFn).toHaveBeenCalledTimes(1);
    const [name, input, ctxArg, opts] = invokeFn.mock.calls[0]!;
    expect(name).toBe(agentMemoryRecall.name);
    expect(input).toMatchObject({
      query: "why did the deploy fail?",
      limit: 6,
      executionRef: "exec-42",
    });
    expect(ctxArg).toBe(CTX);
    expect(opts).toMatchObject({ surface: "agent" });

    expect(msg?.role).toBe("user");
    expect(String(msg?.content)).toContain("Prior lesson");
  });

  it("truncates the query to 500 chars before recall", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ memories: [] });
    await recallWorkspaceMemory({
      query: "x".repeat(900),
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    const input = invokeFn.mock.calls[0]![1] as { query: string };
    expect(input.query).toHaveLength(500);
  });

  it("returns null (turn untouched) when recall throws", async () => {
    const invokeFn = vi.fn().mockRejectedValue(new Error("neo4j down"));
    const msg = await recallWorkspaceMemory({
      query: "anything",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    expect(msg).toBeNull();
  });

  it("returns null when recall yields no memories", async () => {
    const invokeFn = vi.fn().mockResolvedValue({ memories: [] });
    const msg = await recallWorkspaceMemory({
      query: "anything",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    expect(msg).toBeNull();
  });

  it("returns null when an empty/whitespace query would produce a useless recall", async () => {
    const invokeFn = vi.fn();
    const msg = await recallWorkspaceMemory({
      query: "   ",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
    });
    expect(msg).toBeNull();
    expect(invokeFn).not.toHaveBeenCalled();
  });

  it("returns null when recall exceeds the timeout budget", async () => {
    // Never resolves — the timeout race must win and yield null.
    const invokeFn = vi.fn(() => new Promise<unknown>(() => {}));
    const msg = await recallWorkspaceMemory({
      query: "slow",
      executionRef: "exec-1",
      ctx: CTX,
      invokeFn,
      timeoutMs: 10,
    });
    expect(msg).toBeNull();
  });
});

describe("injectRecalledMemory", () => {
  it("inserts the recalled message immediately before the latest user message", () => {
    const messages: ModelMessage[] = [
      userMsg("first"),
      { role: "assistant", content: "reply" },
      userMsg("current question"),
    ];
    const recalled = buildRecalledMemoryMessage([memory({ lesson: "Injected" })]);

    const out = injectRecalledMemory(messages, recalled);

    expect(out).toHaveLength(4);
    // recalled sits at index 2, right before the latest user message (now index 3)
    expect(String(out[2]?.content)).toContain("Injected");
    expect(out[3]).toEqual(userMsg("current question"));
    // The current user message is still the LAST message the model sees.
    expect(out[out.length - 1]).toEqual(userMsg("current question"));
  });

  it("is a no-op when there is nothing to inject", () => {
    const messages: ModelMessage[] = [userMsg("only")];
    const out = injectRecalledMemory(messages, null);
    expect(out).toEqual(messages);
  });

  it("prepends when the only message is the user turn", () => {
    const messages: ModelMessage[] = [userMsg("solo")];
    const recalled = buildRecalledMemoryMessage([memory()]);
    const out = injectRecalledMemory(messages, recalled);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(recalled);
    expect(out[1]).toEqual(userMsg("solo"));
  });
});
