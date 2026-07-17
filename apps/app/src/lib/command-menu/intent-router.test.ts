/**
 * intent-router.test.ts — unit tests for classifyIntent and helpers.
 *
 * Covers:
 *   (a) Fill intent when hasFillableForm=true and query starts with a fill verb
 *   (b) Navigate match for a known nav target label
 *   (c) Search intent for question prefix
 *   (d) Action intent for imperative verb
 *   (e) Fallback Ask intent
 *   (f) looksLikeNavigate gate — nav prefix queries match before search/action
 *   (g) Empty query returns Ask
 */

import { describe, it, expect, vi } from "vitest";
import { classifyIntent } from "./intent-router";

// ---------------------------------------------------------------------------
// Mock enumerateNavTargets so tests don't need a real ScopeContext or DB.
// ---------------------------------------------------------------------------

vi.mock("@/lib/sidebar", () => ({
  enumerateNavTargets: (_ctx: unknown) => [
    { label: "Sessions", href: "/acme/prod/sessions", parent: "sessions" },
    { label: "Knowledge", href: "/acme/prod/knowledge", parent: "knowledge" },
    {
      label: "Billing · Invoices",
      href: "/acme/billing/invoices",
      parent: "billing",
    },
    { label: "Members", href: "/acme/members", parent: "members" },
  ],
}));

const ctx = { orgSlug: "acme", workspaceSlug: "prod" };

// ---------------------------------------------------------------------------
// (a) Fill intent
// ---------------------------------------------------------------------------

describe("Fill intent", () => {
  it("returns fill when hasFillableForm=true and query starts with a fill verb", () => {
    const result = classifyIntent({
      query: "fill in the project name",
      ctx,
      hasFillableForm: true,
    });
    expect(result.type).toBe("fill");
    if (result.type === "fill") {
      expect(result.instruction).toBe("fill in the project name");
    }
  });

  it("does NOT return fill when hasFillableForm=false even with a fill verb", () => {
    const result = classifyIntent({
      query: "fill in the project name",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).not.toBe("fill");
  });

  it("matches 'update' as a fill verb", () => {
    const result = classifyIntent({
      query: "update the description",
      ctx,
      hasFillableForm: true,
    });
    expect(result.type).toBe("fill");
  });

  it("matches 'edit' as a fill verb", () => {
    const result = classifyIntent({
      query: "edit the title field",
      ctx,
      hasFillableForm: true,
    });
    expect(result.type).toBe("fill");
  });
});

// ---------------------------------------------------------------------------
// (b) Navigate intent
// ---------------------------------------------------------------------------

describe("Navigate intent", () => {
  it("returns navigate for an exact label match", () => {
    const result = classifyIntent({
      query: "Sessions",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("navigate");
    if (result.type === "navigate") {
      expect(result.href).toBe("/acme/prod/sessions");
      expect(result.label).toBe("Sessions");
    }
  });

  it("returns navigate with a nav prefix stripped", () => {
    const result = classifyIntent({
      query: "go to Knowledge",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("navigate");
    if (result.type === "navigate") {
      expect(result.href).toBe("/acme/prod/knowledge");
    }
  });

  it("returns navigate for a partial fuzzy label match", () => {
    const result = classifyIntent({
      query: "invoices",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("navigate");
    if (result.type === "navigate") {
      expect(result.href).toBe("/acme/billing/invoices");
    }
  });

  it("returns navigate with 'open' prefix", () => {
    const result = classifyIntent({
      query: "open members",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("navigate");
    if (result.type === "navigate") {
      expect(result.href).toBe("/acme/members");
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Search intent
// ---------------------------------------------------------------------------

describe("Search intent", () => {
  it("returns search for a 'who' prefix query that has no nav match", () => {
    const result = classifyIntent({
      query: "who created this workspace",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("search");
    if (result.type === "search") {
      expect(result.query).toBe("who created this workspace");
    }
  });

  it("returns search for a 'list' prefix", () => {
    const result = classifyIntent({
      query: "list all active runs",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("search");
  });

  it("returns search for a 'find' prefix", () => {
    const result = classifyIntent({
      query: "find the latest invoice",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("search");
  });
});

// ---------------------------------------------------------------------------
// (d) Action intent
// ---------------------------------------------------------------------------

describe("Action intent", () => {
  it("returns action for 'create' verb with no nav match", () => {
    const result = classifyIntent({
      query: "create a new agent",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("action");
    if (result.type === "action") {
      expect(result.verb).toBe("create");
      expect(result.query).toBe("create a new agent");
    }
  });

  it("returns action for 'delete' verb", () => {
    const result = classifyIntent({
      query: "delete this workspace",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("action");
    if (result.type === "action") {
      expect(result.verb).toBe("delete");
    }
  });

  it("returns action for 'invite' verb", () => {
    const result = classifyIntent({
      query: "invite a new team member",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("action");
  });
});

// ---------------------------------------------------------------------------
// (e) Fallback Ask intent
// ---------------------------------------------------------------------------

describe("Ask fallback", () => {
  it("returns ask for a query that matches none of the other intents", () => {
    const result = classifyIntent({
      query: "something completely unmatched xyz123",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("ask");
    if (result.type === "ask") {
      expect(result.query).toBe("something completely unmatched xyz123");
    }
  });

  it("returns ask for an empty string", () => {
    const result = classifyIntent({ query: "", ctx, hasFillableForm: false });
    expect(result.type).toBe("ask");
  });

  it("returns ask for a whitespace-only string", () => {
    const result = classifyIntent({
      query: "   ",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("ask");
  });
});

// ---------------------------------------------------------------------------
// (f) looksLikeNavigate gate — nav prefix queries are attempted for nav match
// ---------------------------------------------------------------------------

describe("nav prefix routing", () => {
  it("'go to' prefix strips correctly so the remainder fuzzy-matches a label", () => {
    const result = classifyIntent({
      query: "go to Knowledge",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("navigate");
  });

  it("'navigate to' prefix strips correctly", () => {
    const result = classifyIntent({
      query: "navigate to Members",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("navigate");
  });

  it("'show me' prefix strips correctly", () => {
    const result = classifyIntent({
      query: "show me Knowledge",
      ctx,
      hasFillableForm: false,
    });
    expect(result.type).toBe("navigate");
  });
});
