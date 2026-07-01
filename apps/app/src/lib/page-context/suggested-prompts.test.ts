/**
 * suggested-prompts.test.ts — unit tests for deriveSuggestions and classifyRoute.
 *
 * All tests target pure functions (no React, no hooks) so vitest's default node
 * environment is sufficient — no jsdom needed.
 *
 * Invariant:  deriveSuggestions always returns exactly 3 items.
 * Contract:   each item has a non-empty label (≤40 chars) and a non-empty prompt.
 *
 * Scenario coverage:
 *   A. Settings route with a registered fillable form
 *   B. Billing route, no entity, no form
 *   C. Conversation (/ask) route, with a workspace entity
 *   D. Default (workspace overview) route, no entity, no form
 *   E. Account route with a user entity and a form
 *   F. Knowledge route
 *   G. classifyRoute recognises all section strings
 */

import { describe, it, expect } from "vitest";
import { deriveSuggestions, classifyRoute, type SuggestionCtx } from "./suggested-prompts";
import type { PageEntity, RegisteredFillableForm } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const wsEntity: PageEntity = {
  kind: "workspace",
  id: "ws-1",
  label: "Production",
  summary: "Primary production workspace.",
};

const profileEntity: PageEntity = {
  kind: "user",
  id: "user-1",
  label: "Mac Anderson",
};

const mockForm: RegisteredFillableForm = {
  formId: "workspace-general",
  title: "Workspace Settings",
  fields: [
    { name: "name", label: "Name", type: "text", current: "Production" },
    { name: "slug", label: "Slug", type: "text", current: "production" },
  ],
  apply: () => undefined,
};

// ---------------------------------------------------------------------------
// Helper — build a minimal SuggestionCtx
// ---------------------------------------------------------------------------

function ctx(
  pathname: string,
  entity: PageEntity | null = null,
  fillableForm: RegisteredFillableForm | null = null,
): SuggestionCtx {
  return { pathname, entity, fillableForm };
}

// ---------------------------------------------------------------------------
// Invariant: always exactly 3 prompts with non-empty label + prompt
// ---------------------------------------------------------------------------

describe("invariant: always exactly 3 SuggestedPrompts", () => {
  const cases: [string, SuggestionCtx][] = [
    ["settings with form + entity", ctx("/acme/prod/settings/general", wsEntity, mockForm)],
    ["billing no entity no form", ctx("/acme/billing/subscription")],
    ["conversation with ws entity", ctx("/acme/prod/ask", wsEntity)],
    ["default no entity no form", ctx("/acme/prod")],
    ["account with user entity + form", ctx("/account/profile", profileEntity, mockForm)],
    ["knowledge no extras", ctx("/acme/prod/knowledge")],
  ];

  for (const [name, c] of cases) {
    it(`returns exactly 3 for "${name}"`, () => {
      const prompts = deriveSuggestions(c);
      expect(prompts).toHaveLength(3);
    });

    it(`all items have non-empty label and prompt for "${name}"`, () => {
      const prompts = deriveSuggestions(c);
      for (const p of prompts) {
        expect(p.label.length).toBeGreaterThan(0);
        expect(p.prompt.length).toBeGreaterThan(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// A. Settings route with fillable form — first chip is always the fill chip
// ---------------------------------------------------------------------------

describe("A: settings route with fillable form", () => {
  const prompts = deriveSuggestions(
    ctx("/acme/prod/settings/general", wsEntity, mockForm),
  );

  it("slot 0 is the fill chip when a form is registered", () => {
    expect(prompts[0]?.label).toMatch(/Fill/i);
    expect(prompts[0]?.prompt).toMatch(/Workspace Settings/);
  });

  it("slot 1 is the entity chip for a workspace entity", () => {
    expect(prompts[1]?.label).toBeDefined();
    expect(prompts[1]?.prompt).toMatch(/Production/);
  });

  it("slot 2 is a settings-specific chip", () => {
    expect(prompts[2]?.prompt).toMatch(/setting/i);
  });
});

// ---------------------------------------------------------------------------
// B. Billing route, no entity, no form
// ---------------------------------------------------------------------------

describe("B: billing route, no entity, no form", () => {
  const prompts = deriveSuggestions(ctx("/acme/billing/subscription"));

  it("prompts are billing-specific", () => {
    const texts = prompts.map((p) => p.prompt.toLowerCase()).join(" ");
    expect(texts).toMatch(/usage|cost|plan|billing/i);
  });

  it("no fill chip (no form registered)", () => {
    const fillChip = prompts.find((p) => p.label.toLowerCase().startsWith("fill"));
    expect(fillChip).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C. Conversation route with workspace entity
// ---------------------------------------------------------------------------

describe("C: conversation route with workspace entity", () => {
  const prompts = deriveSuggestions(ctx("/acme/prod/ask", wsEntity));

  it("entity chip references workspace label", () => {
    const entityChip = prompts.find((p) => p.prompt.includes("Production"));
    expect(entityChip).toBeDefined();
  });

  it("conversation chips reference conversation context", () => {
    const convChip = prompts.find(
      (p) => p.prompt.toLowerCase().includes("conversation") || p.prompt.toLowerCase().includes("thread"),
    );
    expect(convChip).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// D. Default (workspace overview) route, no entity, no form
// ---------------------------------------------------------------------------

describe("D: default route, no entity, no form", () => {
  const prompts = deriveSuggestions(ctx("/acme/prod"));

  it("provides 3 generic orientation chips", () => {
    expect(prompts).toHaveLength(3);
  });

  it("at least one chip mentions orientation or dashboard", () => {
    const texts = prompts.map((p) => p.prompt.toLowerCase()).join(" ");
    expect(texts).toMatch(/orientation|dashboard|workspace|recent|optimize/);
  });
});

// ---------------------------------------------------------------------------
// E. Account route with user entity and a form
// ---------------------------------------------------------------------------

describe("E: account route with user entity + form", () => {
  const prompts = deriveSuggestions(
    ctx("/account/profile", profileEntity, mockForm),
  );

  it("fill chip is slot 0", () => {
    expect(prompts[0]?.label).toMatch(/Fill/i);
  });

  it("entity chip references profile / user context", () => {
    const entityChip = prompts[1];
    expect(entityChip).toBeDefined();
    expect(entityChip?.prompt.toLowerCase()).toMatch(/profile|settings|review/);
  });
});

// ---------------------------------------------------------------------------
// F. Knowledge route
// ---------------------------------------------------------------------------

describe("F: knowledge route", () => {
  const prompts = deriveSuggestions(ctx("/acme/prod/knowledge/sources"));

  it("prompts are knowledge-specific", () => {
    const texts = prompts.map((p) => p.prompt.toLowerCase()).join(" ");
    expect(texts).toMatch(/knowledge|source|gap|stale/);
  });
});

// ---------------------------------------------------------------------------
// G. classifyRoute covers all sections
// ---------------------------------------------------------------------------

describe("classifyRoute", () => {
  const cases: [string, string][] = [
    ["/acme/billing/invoices", "billing"],
    ["/acme/prod/settings/general", "settings"],
    ["/acme/prod/ask", "conversation"],
    ["/acme/prod/chat", "conversation"],
    ["/acme/prod/knowledge/sources", "knowledge"],
    ["/acme/prod/agents", "default"],
    ["/acme/prod/agents/repo-review", "default"],
    ["/acme/prod/automation/agents", "default"],
    ["/acme/prod/activity/runs", "default"],
    ["/account/profile", "account"],
    ["/acme/members", "members"],
    ["/acme/developer/mcp", "developer"],
    ["/acme/prod", "default"],
    ["/", "default"],
  ];

  for (const [path, expected] of cases) {
    it(`classifies "${path}" as "${expected}"`, () => {
      expect(classifyRoute(path)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// H. No duplicate prompts across the 3 slots
// ---------------------------------------------------------------------------

describe("no duplicate prompts across slots", () => {
  const variations: SuggestionCtx[] = [
    ctx("/acme/prod/settings/general", wsEntity, mockForm),
    ctx("/acme/billing"),
    ctx("/acme/prod/ask"),
    ctx("/account/profile", profileEntity),
    ctx("/acme/prod/knowledge"),
    ctx("/acme/prod"),
  ];

  for (const c of variations) {
    it(`no duplicate prompt text for "${c.pathname}"`, () => {
      const prompts = deriveSuggestions(c);
      const texts = prompts.map((p) => p.prompt);
      expect(new Set(texts).size).toBe(texts.length);
    });
  }
});
