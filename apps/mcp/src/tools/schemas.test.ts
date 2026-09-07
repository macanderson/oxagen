// schemas.test.ts — unit tests for MCP tool input-schema validation.
//
// Each tool exports a `schema` object (Record<string, ZodType>). These tests
// wrap each schema in z.object() and assert that valid inputs parse cleanly
// and that invalid inputs produce structured ZodErrors. No network / DB / xmcp
// runtime is involved — pure schema logic.

import { describe, it, expect } from "vitest";
import { obj } from "./_schema-test-helpers";

// ── organization.create ───────────────────────────────────────────────────────

import { schema as orgCreateSchema } from "./org.create";

describe("organization.create schema", () => {
  const Schema = obj(orgCreateSchema);

  it("accepts a valid organization payload", () => {
    expect(() =>
      Schema.parse({ name: "Acme Corp", slug: "acme-corp", planSlug: "free" }),
    ).not.toThrow();
  });

  it("defaults planSlug to 'free' when omitted", () => {
    const result = Schema.parse({ name: "Acme Corp", slug: "acme-corp" });
    expect(result.planSlug).toBe("free");
  });

  it("rejects an empty name", () => {
    expect(() => Schema.parse({ name: "", slug: "acme-corp" })).toThrow();
  });

  it("rejects a slug with uppercase letters", () => {
    expect(() => Schema.parse({ name: "Acme", slug: "Acme-Corp" })).toThrow();
  });

  it("rejects a slug with spaces", () => {
    expect(() => Schema.parse({ name: "Acme", slug: "acme corp" })).toThrow();
  });

  it("rejects a slug shorter than 2 characters", () => {
    expect(() => Schema.parse({ name: "Acme", slug: "a" })).toThrow();
  });

  it("rejects a slug longer than 40 characters", () => {
    expect(() =>
      Schema.parse({ name: "Acme", slug: "a".repeat(41) }),
    ).toThrow();
  });
});

// ── workspace.create ─────────────────────────────────────────────────────────

import { schema as workspaceCreateSchema } from "./workspace.create";

describe("workspace.create schema", () => {
  const Schema = obj(workspaceCreateSchema);

  it("accepts a valid workspace payload", () => {
    expect(() =>
      Schema.parse({ name: "My Workspace", slug: "my-workspace" }),
    ).not.toThrow();
  });

  it("rejects an empty name", () => {
    expect(() => Schema.parse({ name: "", slug: "my-workspace" })).toThrow();
  });

  it("rejects a slug with special characters", () => {
    expect(() => Schema.parse({ name: "WS", slug: "my_workspace!" })).toThrow();
  });

  it("rejects a slug longer than 40 characters", () => {
    expect(() => Schema.parse({ name: "WS", slug: "w".repeat(41) })).toThrow();
  });
});

// ── agent.memory.recall ───────────────────────────────────────────────────────

import { schema as agentMemoryRecallSchema } from "./agent.memory.recall";

describe("agent.memory.recall schema", () => {
  const Schema = obj(agentMemoryRecallSchema);

  it("accepts a minimal valid payload", () => {
    const result = Schema.parse({ query: "user preferences" });
    expect(result.memoryClass).toBeUndefined();
    expect(result.limit).toBe(10); // default
  });

  it("accepts a fully-specified payload", () => {
    const result = Schema.parse({
      query: "recent tasks",
      memoryClass: "RULE",
      minEnforcement: 80,
      limit: 25,
      nodeRef: "node-abc",
    });
    expect(result.memoryClass).toBe("RULE");
    expect(result.minEnforcement).toBe(80);
    expect(result.limit).toBe(25);
    expect(result.nodeRef).toBe("node-abc");
  });

  it("rejects an empty query", () => {
    expect(() => Schema.parse({ query: "" })).toThrow();
  });

  it("rejects a limit above 50", () => {
    expect(() => Schema.parse({ query: "q", limit: 51 })).toThrow();
  });

  it("rejects a limit of 0 (must be positive)", () => {
    expect(() => Schema.parse({ query: "q", limit: 0 })).toThrow();
  });

  it("rejects an invalid memoryClass value", () => {
    expect(() => Schema.parse({ query: "q", memoryClass: "MEDIUM" })).toThrow();
  });

  it("rejects a minEnforcement above 100", () => {
    expect(() => Schema.parse({ query: "q", minEnforcement: 101 })).toThrow();
  });
});

// ── chat.message.send ─────────────────────────────────────────────────────────

import { schema as chatMessageSendSchema } from "./chat.message.send";

describe("chat.message.send schema", () => {
  const Schema = obj(chatMessageSendSchema);

  it("accepts a minimal valid new-conversation message", () => {
    const result = Schema.parse({
      conversationId: null,

      parentMessageId: null,
      branchReason: null,
      content: "Hello, Oxagen!",
    });
    expect(result.contentBlocks).toEqual([]); // default
  });

  it("accepts a branching message with all fields", () => {
    expect(() =>
      Schema.parse({
        conversationId: "conv-1",

        parentMessageId: "msg-1",
        branchReason: "edit",
        content: "Updated message",
        contentBlocks: [{ type: "text", text: "block" }],
      }),
    ).not.toThrow();
  });

  it("rejects an empty content string", () => {
    expect(() =>
      Schema.parse({
        conversationId: null,

        parentMessageId: null,
        branchReason: null,
        content: "",
      }),
    ).toThrow();
  });

  it("rejects an invalid branchReason enum value", () => {
    expect(() =>
      Schema.parse({
        conversationId: null,

        parentMessageId: null,
        branchReason: "bad_reason",
        content: "Hello",
      }),
    ).toThrow();
  });

  it("accepts all valid branchReason values", () => {
    for (const branchReason of [
      "edit",
      "regenerate",
      "tool_retry",
      "manual_fork",
    ] as const) {
      expect(() =>
        Schema.parse({
          conversationId: "c",

          parentMessageId: "p",
          branchReason,
          content: "Hi",
        }),
      ).not.toThrow();
    }
  });
});

