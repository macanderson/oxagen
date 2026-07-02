/**
 * Unit tests for the paste placeholder registry (paste.ts) — pure logic, no
 * React/ink. Covers the threshold, token grammar, atomic-deletion spans,
 * pruning, and submission expansion that back `PromptInput`'s paste UX.
 */
import { describe, it, expect } from "vitest";
import {
  createPasteRegistry,
  resetPasteRegistry,
  shouldCollapseText,
  PASTE_TEXT_CHAR_THRESHOLD,
  PASTE_TEXT_LINE_THRESHOLD,
  textToken,
  imageToken,
  registerPastedText,
  registerPastedImage,
  tokenEndingAt,
  tokenStartingAt,
  dropTokenAt,
  pruneMissingTokens,
  expandPasteSubmission,
} from "../paste.js";

describe("shouldCollapseText — the >400 chars OR >=6 lines threshold", () => {
  it("keeps a short, few-line paste inline", () => {
    expect(shouldCollapseText("hello world")).toBe(false);
    expect(shouldCollapseText("line1\nline2\nline3")).toBe(false);
  });

  it("collapses text over the char threshold even on one line", () => {
    const text = "a".repeat(PASTE_TEXT_CHAR_THRESHOLD + 1);
    expect(shouldCollapseText(text)).toBe(true);
  });

  it("does not collapse text exactly AT the char threshold", () => {
    const text = "a".repeat(PASTE_TEXT_CHAR_THRESHOLD);
    expect(shouldCollapseText(text)).toBe(false);
  });

  it("collapses text at or over the line threshold even if short", () => {
    const text = Array.from({ length: PASTE_TEXT_LINE_THRESHOLD }, (_, i) => `l${i}`).join("\n");
    expect(shouldCollapseText(text)).toBe(true);
  });

  it("does not collapse one line under the line threshold", () => {
    const text = Array.from({ length: PASTE_TEXT_LINE_THRESHOLD - 1 }, (_, i) => `l${i}`).join("\n");
    expect(shouldCollapseText(text)).toBe(false);
  });
});

describe("registry — registration + per-prompt counters", () => {
  it("numbers text and image tokens independently, starting at 1", () => {
    const registry = createPasteRegistry();
    expect(registerPastedText(registry, "first paste")).toBe("[Text #1]");
    expect(registerPastedText(registry, "second paste")).toBe("[Text #2]");
    expect(registerPastedImage(registry, { path: "/tmp/a.png", mediaType: "image/png" })).toBe(
      "[Image #1]",
    );
    expect(registerPastedText(registry, "third paste")).toBe("[Text #3]");
    expect(registerPastedImage(registry, { path: "/tmp/b.png", mediaType: "image/png" })).toBe(
      "[Image #2]",
    );
  });

  it("resetPasteRegistry clears entries and restarts both counters at 1", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "a");
    registerPastedImage(registry, { path: "/tmp/a.png", mediaType: "image/png" });
    resetPasteRegistry(registry);
    expect(registry.texts.size).toBe(0);
    expect(registry.images.size).toBe(0);
    expect(registerPastedText(registry, "fresh")).toBe("[Text #1]");
    expect(registerPastedImage(registry, { path: "/tmp/c.png", mediaType: "image/png" })).toBe(
      "[Image #1]",
    );
  });

  it("token helpers format the exact grammar (space before #)", () => {
    expect(textToken(7)).toBe("[Text #7]");
    expect(imageToken(3)).toBe("[Image #3]");
  });
});

describe("tokenEndingAt / tokenStartingAt — atomic deletion spans", () => {
  it("finds a full Text token ending exactly at the cursor", () => {
    const text = "see [Text #1] please";
    const pos = "see [Text #1]".length;
    expect(tokenEndingAt(text, pos)).toEqual({ start: 4, end: pos });
  });

  it("finds a full Image token ending exactly at the cursor", () => {
    const text = "look [Image #12]";
    expect(tokenEndingAt(text, text.length)).toEqual({ start: 5, end: text.length });
  });

  it("returns null when the cursor is mid-token, not at its end", () => {
    const text = "[Text #1]";
    // Cursor sits before the closing bracket — no full token ends here.
    expect(tokenEndingAt(text, text.length - 1)).toBeNull();
  });

  it("returns null when there is no token immediately before the cursor", () => {
    expect(tokenEndingAt("plain text", 5)).toBeNull();
  });

  it("finds a full token starting exactly at the cursor (forward delete)", () => {
    const text = "[Image #1] trailing";
    expect(tokenStartingAt(text, 0)).toEqual({ start: 0, end: "[Image #1]".length });
  });

  it("returns null when no token starts at the cursor", () => {
    expect(tokenStartingAt("no tokens here", 3)).toBeNull();
  });
});

describe("dropTokenAt — removing the registry entry for a deleted token", () => {
  it("drops the matching text entry", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "full content");
    const text = "[Text #1]";
    dropTokenAt(registry, text, { start: 0, end: text.length });
    expect(registry.texts.has(1)).toBe(false);
  });

  it("drops the matching image entry", () => {
    const registry = createPasteRegistry();
    registerPastedImage(registry, { path: "/tmp/a.png", mediaType: "image/png" });
    const text = "[Image #1]";
    dropTokenAt(registry, text, { start: 0, end: text.length });
    expect(registry.images.has(1)).toBe(false);
  });

  it("is a no-op for a span that isn't a recognized token", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "kept");
    dropTokenAt(registry, "not a token", { start: 0, end: 3 });
    expect(registry.texts.get(1)).toBe("kept");
  });
});

describe("pruneMissingTokens — the 'at minimum, drop at submit' contract", () => {
  it("drops entries whose token no longer appears anywhere in the buffer", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "gone"); // 1
    registerPastedText(registry, "kept"); // 2
    // Token 1 was mangled by mid-token editing and no longer reads intact.
    pruneMissingTokens(registry, "some [Text mangled and [Text #2] intact");
    expect(registry.texts.has(1)).toBe(false);
    expect(registry.texts.get(2)).toBe("kept");
  });

  it("leaves intact entries alone", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "content");
    pruneMissingTokens(registry, "[Text #1] still here");
    expect(registry.texts.get(1)).toBe("content");
  });
});

describe("expandPasteSubmission — the model-bound expansion", () => {
  it("expands a single Text token inline", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "the FULL pasted body\nacross lines");
    const result = expandPasteSubmission(registry, "please review [Text #1] now");
    expect(result.expandedText).toBe("please review the FULL pasted body\nacross lines now");
    expect(result.images).toEqual([]);
  });

  it("expands multiple Text tokens in order", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "AAA");
    registerPastedText(registry, "BBB");
    const result = expandPasteSubmission(registry, "[Text #1] then [Text #2]");
    expect(result.expandedText).toBe("AAA then BBB");
  });

  it("replaces an Image token with a literal note and lists the attachment", () => {
    const registry = createPasteRegistry();
    const attachment = { path: "/tmp/shot.png", mediaType: "image/png" };
    registerPastedImage(registry, attachment);
    const result = expandPasteSubmission(registry, "what's wrong here: [Image #1]");
    expect(result.expandedText).toBe("what's wrong here: (attached image)");
    expect(result.images).toEqual([attachment]);
  });

  it("collects multiple images in the order they appear in the text, not registration order", () => {
    const registry = createPasteRegistry();
    const first = { path: "/tmp/1.png", mediaType: "image/png" };
    const second = { path: "/tmp/2.png", mediaType: "image/png" };
    registerPastedImage(registry, first); // #1
    registerPastedImage(registry, second); // #2
    // Referenced in reverse order in the final text.
    const result = expandPasteSubmission(registry, "[Image #2] before [Image #1]");
    expect(result.images).toEqual([second, first]);
  });

  it("handles a mix of text and image tokens together", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "stack trace here");
    registerPastedImage(registry, { path: "/tmp/a.png", mediaType: "image/png" });
    const result = expandPasteSubmission(registry, "[Text #1] and [Image #1]");
    expect(result.expandedText).toBe("stack trace here and (attached image)");
    expect(result.images).toHaveLength(1);
  });

  it("leaves a token with no registry entry as literal text (never silently dropped)", () => {
    const registry = createPasteRegistry();
    const result = expandPasteSubmission(registry, "please handle ticket [Image #99]");
    expect(result.expandedText).toBe("please handle ticket [Image #99]");
    expect(result.images).toEqual([]);
  });

  it("is a no-op on plain text with no tokens at all", () => {
    const registry = createPasteRegistry();
    const result = expandPasteSubmission(registry, "just a normal prompt");
    expect(result).toEqual({ expandedText: "just a normal prompt", images: [] });
  });

  it("prunes stale entries as part of expansion", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "orphaned"); // never referenced below
    expandPasteSubmission(registry, "no tokens in this text");
    expect(registry.texts.has(1)).toBe(false);
  });
});
