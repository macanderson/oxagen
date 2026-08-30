// conversations.schema.test.ts — unit tests for conversation tool input schemas.
//
// Covers: conversation.archive, conversation.rename, conversation.list.
// Pure schema logic; no network / DB / xmcp runtime involved.

import { describe, it, expect } from "vitest";
import { obj } from "./_schema-test-helpers";

// ── conversation.archive ─────────────────────────────────────────────────────

import { schema as conversationArchiveSchema } from "./conversation.archive";

describe("conversation.archive schema", () => {
  const Schema = obj(conversationArchiveSchema);

  it("accepts a valid archive request with one conversation id", () => {
    expect(() =>
      Schema.parse({ conversationIds: ["cnv_abc"], archived: true }),
    ).not.toThrow();
  });

  it("accepts a restore request (archived: false)", () => {
    const result = Schema.parse({
      conversationIds: ["cnv_abc"],
      archived: false,
    });
    expect(result.archived).toBe(false);
  });

  it("accepts exactly 100 conversation ids (upper boundary)", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `cnv_${i}`);
    expect(() =>
      Schema.parse({ conversationIds: ids, archived: true }),
    ).not.toThrow();
  });

  it("rejects an empty conversationIds array (min 1)", () => {
    expect(() =>
      Schema.parse({ conversationIds: [], archived: true }),
    ).toThrow();
  });

  it("rejects 101 conversation ids (max 100)", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `cnv_${i}`);
    expect(() =>
      Schema.parse({ conversationIds: ids, archived: true }),
    ).toThrow();
  });

  it("rejects an inner id that is an empty string (inner min 1)", () => {
    expect(() =>
      Schema.parse({ conversationIds: [""], archived: true }),
    ).toThrow();
  });

  it("rejects missing archived field", () => {
    expect(() => Schema.parse({ conversationIds: ["cnv_abc"] })).toThrow();
  });

  it("rejects non-boolean archived (e.g. string 'true')", () => {
    expect(() =>
      Schema.parse({ conversationIds: ["cnv_abc"], archived: "true" }),
    ).toThrow();
  });

  it("rejects non-boolean archived (e.g. number 1)", () => {
    expect(() =>
      Schema.parse({ conversationIds: ["cnv_abc"], archived: 1 }),
    ).toThrow();
  });

  it("accepts 2 valid conversation ids", () => {
    const result = Schema.parse({
      conversationIds: ["cnv_aaa", "cnv_bbb"],
      archived: true,
    });
    expect(result.conversationIds).toHaveLength(2);
  });
});

// ── conversation.rename ──────────────────────────────────────────────────────

import { schema as conversationRenameSchema } from "./conversation.rename";

describe("conversation.rename schema", () => {
  const Schema = obj(conversationRenameSchema);

  it("accepts a valid rename request", () => {
    const result = Schema.parse({
      conversationId: "cnv_abc",
      title: "My convo",
    });
    expect(result.title).toBe("My convo");
  });

  it("accepts a title of exactly 200 characters (upper boundary)", () => {
    expect(() =>
      Schema.parse({ conversationId: "cnv_abc", title: "a".repeat(200) }),
    ).not.toThrow();
  });

  it("rejects a title of 201 characters (one over max)", () => {
    expect(() =>
      Schema.parse({ conversationId: "cnv_abc", title: "a".repeat(201) }),
    ).toThrow();
  });

  it("rejects a whitespace-only title after trim (min 1)", () => {
    // The contract uses z.string().trim().min(1) — trimmed empty string fails.
    expect(() =>
      Schema.parse({ conversationId: "cnv_abc", title: "   " }),
    ).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() =>
      Schema.parse({ conversationId: "cnv_abc", title: "" }),
    ).toThrow();
  });

  it("rejects an empty conversationId (min 1)", () => {
    expect(() =>
      Schema.parse({ conversationId: "", title: "Valid title" }),
    ).toThrow();
  });

  it("rejects missing conversationId", () => {
    expect(() => Schema.parse({ title: "Valid title" })).toThrow();
  });

  it("rejects missing title", () => {
    expect(() => Schema.parse({ conversationId: "cnv_abc" })).toThrow();
  });

  it("trims leading/trailing whitespace from title (contract uses .trim())", () => {
    const result = Schema.parse({
      conversationId: "cnv_abc",
      title: "  Hello World  ",
    });
    expect(result.title).toBe("Hello World");
  });
});

// ── conversation.list ────────────────────────────────────────────────────────

import { schema as conversationListSchema } from "./conversation.list";

describe("conversation.list schema", () => {
  const Schema = obj(conversationListSchema);

  it("uses defaults when no fields are provided", () => {
    const result = Schema.parse({});
    expect(result.filter).toBe("active");
    expect(result.limit).toBe(50);
    expect(result.cursor).toBeNull();
  });

  it("accepts filter 'active'", () => {
    const result = Schema.parse({ filter: "active" });
    expect(result.filter).toBe("active");
  });

  it("accepts filter 'archived'", () => {
    const result = Schema.parse({ filter: "archived" });
    expect(result.filter).toBe("archived");
  });

  it("rejects an invalid filter enum value", () => {
    expect(() => Schema.parse({ filter: "deleted" })).toThrow();
  });

  it("rejects filter 'all' (not in enum)", () => {
    expect(() => Schema.parse({ filter: "all" })).toThrow();
  });

  it("accepts limit 1 (lower boundary)", () => {
    expect(() => Schema.parse({ limit: 1 })).not.toThrow();
  });

  it("accepts limit 100 (upper boundary)", () => {
    expect(() => Schema.parse({ limit: 100 })).not.toThrow();
  });

  it("rejects limit 0 (below min 1)", () => {
    expect(() => Schema.parse({ limit: 0 })).toThrow();
  });

  it("rejects limit 101 (above max 100)", () => {
    expect(() => Schema.parse({ limit: 101 })).toThrow();
  });

  it("rejects a fractional limit (must be int)", () => {
    expect(() => Schema.parse({ limit: 1.5 })).toThrow();
  });

  it("rejects a negative limit", () => {
    expect(() => Schema.parse({ limit: -1 })).toThrow();
  });

  it("accepts cursor as null (start of list)", () => {
    const result = Schema.parse({ cursor: null });
    expect(result.cursor).toBeNull();
  });

  it("accepts a non-null cursor string", () => {
    const result = Schema.parse({ cursor: "2024-01-01T00:00:00.000Z" });
    expect(result.cursor).toBe("2024-01-01T00:00:00.000Z");
  });

  it("accepts a fully-specified valid payload", () => {
    const result = Schema.parse({
      filter: "archived",
      limit: 25,
      cursor: "2024-06-01T12:00:00.000Z",
    });
    expect(result.filter).toBe("archived");
    expect(result.limit).toBe(25);
    expect(result.cursor).toBe("2024-06-01T12:00:00.000Z");
  });
});
