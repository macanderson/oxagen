/**
 * suggested-prompt-chips.test.ts
 *
 * Unit tests for SuggestedPromptChips pure helpers:
 *   1. buildChipFormData — constructs correct FormData for chip activation
 *   2. Chip count invariant — chips always render exactly 3 (tested via pure
 *      deriveSuggestions, which underpins useSuggestedPrompts)
 *   3. Auto-submit contract — buildChipFormData sets "content" to the prompt
 */

import { describe, it, expect } from "vitest";
import { buildChipFormData } from "./suggested-prompt-chips";
import { deriveSuggestions } from "@/lib/page-context/suggested-prompts";

// ── buildChipFormData ─────────────────────────────────────────────────────────

describe("buildChipFormData", () => {
  it("sets 'content' to the prompt text", () => {
    const fd = buildChipFormData("Tell me about my workspace", null, null);
    expect(fd.get("content")).toBe("Tell me about my workspace");
  });

  it("sets 'conversationId' when provided", () => {
    const fd = buildChipFormData("Hello", "conv-uuid-123", null);
    expect(fd.get("conversationId")).toBe("conv-uuid-123");
  });

  it("omits 'conversationId' when null", () => {
    const fd = buildChipFormData("Hello", null, null);
    expect(fd.get("conversationId")).toBeNull();
  });

  it("sets 'parentMessageId' when provided", () => {
    const fd = buildChipFormData("Hello", null, "msg-uuid-456");
    expect(fd.get("parentMessageId")).toBe("msg-uuid-456");
  });

  it("omits 'parentMessageId' when null", () => {
    const fd = buildChipFormData("Hello", null, null);
    expect(fd.get("parentMessageId")).toBeNull();
  });

  it("sets both ids when both provided", () => {
    const fd = buildChipFormData("Do a thing", "conv-1", "msg-1");
    expect(fd.get("content")).toBe("Do a thing");
    expect(fd.get("conversationId")).toBe("conv-1");
    expect(fd.get("parentMessageId")).toBe("msg-1");
  });

  it("does not set tier or model (composer resolves defaults server-side)", () => {
    const fd = buildChipFormData("Query", null, null);
    expect(fd.get("tier")).toBeNull();
    expect(fd.get("model")).toBeNull();
  });
});

// ── Chip count invariant (pure) ───────────────────────────────────────────────
// useSuggestedPrompts delegates to deriveSuggestions; testing the pure function
// gives us the invariant that the hook (and therefore the rendered chip count)
// is always exactly 3.

describe("chip count invariant — always exactly 3", () => {
  const pathnames = [
    "/acme/prod/ask",
    "/acme/prod/chat",
    "/acme/billing",
    "/acme/prod/settings/general",
    "/acme/prod/knowledge",
    "/acme/prod",
    "/account/profile",
    "/acme/developer/mcp",
  ];

  for (const pathname of pathnames) {
    it(`deriveSuggestions returns exactly 3 for "${pathname}"`, () => {
      const chips = deriveSuggestions({ pathname, entity: null, fillableForm: null });
      expect(chips).toHaveLength(3);
    });
  }
});

// ── Auto-submit contract ──────────────────────────────────────────────────────
// The chip click handler calls buildChipFormData then passes the result to the
// ComposerAction. The FormData must always include a non-empty "content" field
// so the action's early-return guard (content.trim().length === 0) doesn't
// swallow the message.

describe("auto-submit contract — content is always non-empty", () => {
  const prompts = deriveSuggestions({
    pathname: "/acme/prod/ask",
    entity: null,
    fillableForm: null,
  });

  for (const { prompt, label } of prompts) {
    it(`chip "${label}" produces non-empty content`, () => {
      const fd = buildChipFormData(prompt, null, null);
      const content = fd.get("content");
      expect(typeof content).toBe("string");
      expect((content as string).trim().length).toBeGreaterThan(0);
    });
  }
});
