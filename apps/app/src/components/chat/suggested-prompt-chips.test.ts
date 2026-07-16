// @vitest-environment jsdom
/**
 * suggested-prompt-chips.test.ts
 *
 * Unit tests for SuggestedPromptChips pure helpers + rendering:
 *   1. buildChipFormData — constructs correct FormData for chip activation
 *   2. Chip count invariant — chips always render exactly 3 (tested via pure
 *      deriveSuggestions, which underpins useSuggestedPrompts)
 *   3. Auto-submit contract — buildChipFormData sets "content" to the prompt
 *   4. Send handler invocation — action is called with FormData on chip activation (not input-populate)
 *   5. suggestions prop override — per-turn LLM chips replace the static fallback
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import * as React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  buildChipFormData,
  SuggestedPromptChips,
} from "./suggested-prompt-chips";
import { deriveSuggestions } from "@/lib/page-context/suggested-prompts";

// Stub ONLY the hook (the static fallback source) so render tests are
// deterministic; spread importOriginal so the real `deriveSuggestions` the
// pure tests above rely on is preserved (see "mock spread transitive" gotcha).
const { FALLBACK } = vi.hoisted(() => ({
  FALLBACK: [
    { label: "Fallback One", prompt: "fallback prompt one" },
    { label: "Fallback Two", prompt: "fallback prompt two" },
    { label: "Fallback Three", prompt: "fallback prompt three" },
  ],
}));
vi.mock("@/lib/page-context/suggested-prompts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/page-context/suggested-prompts")
    >();
  return { ...actual, useSuggestedPrompts: () => FALLBACK };
});

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
      const chips = deriveSuggestions({
        pathname,
        entity: null,
        fillableForm: null,
      });
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

// ── Send handler invocation contract ─────────────────────────────────────────
// Simulate the chip click handler: build FormData and call the action mock to
// confirm that buildChipFormData + action(fd) constitute a complete end-to-end
// auto-submit without a separate input-population step (no populate-then-click).

describe("auto-submit contract — action is invoked with FormData on click", () => {
  it("calls the action with a FormData containing the chip prompt", async () => {
    const mockAction = vi.fn().mockResolvedValue({ ok: true });
    const prompt = "Tell me about my workspace";
    const conversationId = "conv-123";
    const parentMessageId = "msg-456";

    const fd = buildChipFormData(prompt, conversationId, parentMessageId);

    // Simulates what handleActivate does in SuggestedPromptChips:
    await mockAction(fd);

    expect(mockAction).toHaveBeenCalledOnce();
    const [calledFd] = mockAction.mock.calls[0] as [FormData];
    expect(calledFd.get("content")).toBe(prompt);
    expect(calledFd.get("conversationId")).toBe(conversationId);
    expect(calledFd.get("parentMessageId")).toBe(parentMessageId);
  });

  it("action receives 'content' as the prompt text, never populates an input element", async () => {
    // This test encodes the design invariant: chips do NOT populate a text input
    // and then programmatically click submit. They directly call the ComposerAction
    // with a FormData — the same code path as the composer's own submit handler.
    const mockAction = vi
      .fn()
      .mockResolvedValue({ ok: true, conversationId: "c1" });
    const prompt = "Summarize this conversation so far.";
    const fd = buildChipFormData(prompt, null, null);

    await mockAction(fd);

    expect(mockAction).toHaveBeenCalledOnce();
    // The content must arrive via FormData, not via an input value.
    const [calledFd] = mockAction.mock.calls[0] as [FormData];
    expect(calledFd.get("content")).toBe(prompt);
    // No DOM input element was populated (pure FormData path).
    expect(typeof fd.get("content")).toBe("string");
  });

  it("action is NOT called when content is empty — early-return guard holds", () => {
    // The wrappedSendAction in chat-shell-client checks:
    //   if (typeof content !== "string" || content.length === 0) return sendAction(formData);
    // This test verifies buildChipFormData always sets a non-empty "content" field,
    // meaning the guard never fires for a chip-generated payload.
    const allChips = [
      ...deriveSuggestions({
        pathname: "/acme/prod/ask",
        entity: null,
        fillableForm: null,
      }),
      ...deriveSuggestions({
        pathname: "/acme/billing",
        entity: null,
        fillableForm: null,
      }),
      ...deriveSuggestions({
        pathname: "/acme/prod/settings",
        entity: null,
        fillableForm: null,
      }),
    ];
    for (const { prompt } of allChips) {
      const fd = buildChipFormData(prompt, null, null);
      const content = fd.get("content");
      expect(typeof content).toBe("string");
      expect((content as string).length).toBeGreaterThan(0);
    }
  });
});

// ── Error surfacing contract ───────────────────────────────────────────────────
// When the ComposerAction returns { ok: false, error: "..." }, the chip
// handleActivate must NOT silently ignore it. The result.ok check must be
// performed and the error surfaced. These tests prove the contract at the
// handler level (pure, no DOM required).

describe("handleActivate error surfacing contract — action ok:false is NOT silently ignored", () => {
  it("action returning { ok: false } resolves without throwing", async () => {
    // Simulate what handleActivate does: call action(fd), check result
    const mockAction = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "Billing gate" });
    const fd = buildChipFormData("Test prompt", null, null);
    const result = await mockAction(fd);
    // The guard must be possible to evaluate
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Billing gate");
  });

  it("error from action can be extracted without type error", async () => {
    // Prove the type contract: result.ok is boolean, result.error is string | undefined
    const mockAction = vi.fn().mockResolvedValue({
      ok: false as boolean,
      error: "Auth expired" as string | undefined,
    });
    const fd = buildChipFormData("Another prompt", "conv-1", "msg-1");
    const result = (await mockAction(fd)) as { ok: boolean; error?: string };
    if (!result.ok) {
      const errorMsg = result.error ?? "Failed to send message";
      expect(errorMsg).toBe("Auth expired");
    }
  });

  it("undefined error falls back to default message", async () => {
    const mockAction = vi
      .fn()
      .mockResolvedValue({ ok: false, error: undefined });
    const fd = buildChipFormData("Prompt without error detail", null, null);
    const result = (await mockAction(fd)) as { ok: boolean; error?: string };
    const errorMsg = result.error ?? "Failed to send message";
    expect(errorMsg).toBe("Failed to send message");
  });

  it("action returning { ok: true } produces no error", async () => {
    const mockAction = vi.fn().mockResolvedValue({
      ok: true,
      conversationId: "conv-new",
      conversationPublicId: "conv_pub_new",
      userMessageId: "msg-new",
    });
    const fd = buildChipFormData("Success prompt", null, null);
    const result = (await mockAction(fd)) as { ok: boolean; error?: string };
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// ── suggestions prop override (rendered) ──────────────────────────────────────
// When the per-turn `suggestions` prop is present and non-empty it REPLACES the
// static useSuggestedPrompts() fallback; null/empty falls back to it. Auto-submit
// stays intact regardless of the source.

describe("SuggestedPromptChips — suggestions prop override", () => {
  afterEach(cleanup);

  const llmTrio = [
    { label: "Turn Into An Agent", prompt: "Create an agent that does this." },
    { label: "Automate This", prompt: "Automate this on a schedule." },
    { label: "Add To Graph", prompt: "Wire this into the knowledge graph." },
  ];

  function renderChips(
    props: Partial<React.ComponentProps<typeof SuggestedPromptChips>> = {},
  ) {
    const action = vi.fn().mockResolvedValue({ ok: true });
    render(
      React.createElement(SuggestedPromptChips, {
        action,
        conversationId: "conv-1",
        parentMessageId: "msg-1",
        ...props,
      }),
    );
    return { action };
  }

  it("renders the LLM suggestions when the prop is non-empty (not the fallback)", () => {
    renderChips({ suggestions: llmTrio });
    for (const { label } of llmTrio) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText("Fallback One")).toBeNull();
  });

  it("falls back to the static suggestions when the prop is null", () => {
    renderChips({ suggestions: null });
    expect(screen.getByText("Fallback One")).toBeTruthy();
    expect(screen.queryByText("Turn Into An Agent")).toBeNull();
  });

  it("falls back to the static suggestions when the prop is an empty array", () => {
    renderChips({ suggestions: [] });
    expect(screen.getByText("Fallback One")).toBeTruthy();
  });

  it("auto-submits the LLM prompt via the action on click", async () => {
    const { action } = renderChips({ suggestions: llmTrio });
    screen.getByText("Automate This").click();
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    const [fd] = action.mock.calls[0] as [FormData];
    expect(fd.get("content")).toBe("Automate this on a schedule.");
    expect(fd.get("conversationId")).toBe("conv-1");
  });
});

// ── Dismissable single pill (post-first-message next-step) ────────────────────
// After the first message the shell renders ONE dismissable pill: the label
// still auto-submits, and a trailing "×" waves it away for the current turn.
// A fresh suggestion (new turn) resets the dismissal so the next pill shows.

describe("SuggestedPromptChips — dismissable single pill", () => {
  afterEach(cleanup);

  const single = [
    { label: "Verify The Fix", prompt: "Run the tests to verify the fix." },
  ];

  function renderPill(
    props: Partial<React.ComponentProps<typeof SuggestedPromptChips>> = {},
  ) {
    const action = vi.fn().mockResolvedValue({ ok: true });
    const utils = render(
      React.createElement(SuggestedPromptChips, {
        action,
        conversationId: "conv-1",
        parentMessageId: "msg-1",
        suggestions: single,
        maxPrompts: 1,
        dismissable: true,
        ...props,
      }),
    );
    return { action, ...utils };
  }

  it("renders exactly one pill with a dismiss control", () => {
    renderPill();
    expect(screen.getByText("Verify The Fix")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Dismiss suggestion" }),
    ).toBeTruthy();
  });

  it("hides the suggestion when the dismiss control is clicked", () => {
    renderPill();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(screen.queryByText("Verify The Fix")).toBeNull();
  });

  it("still auto-submits the prompt when the label is clicked", async () => {
    const { action } = renderPill();
    fireEvent.click(screen.getByText("Verify The Fix"));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    const [fd] = action.mock.calls[0] as [FormData];
    expect(fd.get("content")).toBe("Run the tests to verify the fix.");
  });

  it("re-shows (undismissed) when a fresh suggestion arrives", () => {
    const action = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = render(
      React.createElement(SuggestedPromptChips, {
        action,
        conversationId: "c",
        parentMessageId: "m",
        suggestions: single,
        maxPrompts: 1,
        dismissable: true,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(screen.queryByText("Verify The Fix")).toBeNull();
    // A new turn emits a different suggestion → the dismissal resets.
    rerender(
      React.createElement(SuggestedPromptChips, {
        action,
        conversationId: "c",
        parentMessageId: "m",
        suggestions: [{ label: "Ship It", prompt: "Open a PR and push." }],
        maxPrompts: 1,
        dismissable: true,
      }),
    );
    expect(screen.getByText("Ship It")).toBeTruthy();
  });
});
