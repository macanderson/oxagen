/**
 * Unit tests for the paste placeholder registry (paste.ts) — pure logic, no
 * React/ink. Covers the multi-line collapse rule, the preview-chip grammar
 * (`[first 12…N Lines…last 12]`), edge sanitization, chip-keyed atomic
 * deletion, pruning, and submission expansion that back `PromptInput`'s paste
 * UX.
 */
import { describe, it, expect } from "vitest";
import {
  createPasteRegistry,
  resetPasteRegistry,
  shouldCollapseText,
  countLines,
  CHIP_EDGE,
  textChip,
  imageToken,
  registerPastedText,
  registerPastedImage,
  tokenEndingAt,
  tokenStartingAt,
  dropTokenAt,
  pruneMissingTokens,
  expandPasteSubmission,
} from "../paste.js";

describe("shouldCollapseText — multi-line only", () => {
  it("keeps ANY single-line paste inline, however long", () => {
    expect(shouldCollapseText("hello world")).toBe(false);
    expect(shouldCollapseText("a".repeat(5000))).toBe(false);
  });

  it("collapses the instant the paste spans more than one line", () => {
    expect(shouldCollapseText("line1\nline2")).toBe(true);
    expect(shouldCollapseText("a\nb\nc")).toBe(true);
  });

  it("counts lines by newline, 1 for single-line input", () => {
    expect(countLines("one line")).toBe(1);
    expect(countLines("a\nb\nc")).toBe(3);
  });
});

describe("textChip — the [first 12…N Lines…last 12] preview grammar", () => {
  it("previews head, line count, and tail exactly", () => {
    const text = "AAAAAAAAAAAAAA\nBBBBBBBBBBBBBB"; // 14 A's, newline, 14 B's
    expect(textChip(text)).toBe("[AAAAAAAAAAAA...2 Lines...BBBBBBBBBBBB]");
  });

  it("uses CHIP_EDGE characters of head and tail", () => {
    const text = `${"x".repeat(40)}\n${"y".repeat(40)}`;
    const chip = textChip(text);
    expect(chip).toBe(
      `[${"x".repeat(CHIP_EDGE)}...2 Lines...${"y".repeat(CHIP_EDGE)}]`,
    );
  });

  it("does not duplicate characters when head and tail would overlap", () => {
    // "ab cd" (flattened) is shorter than 2×CHIP_EDGE, so the tail continues
    // where the head stops rather than re-slicing the last 12.
    expect(textChip("ab\ncd")).toBe("[ab cd...2 Lines...]");
  });

  it("flattens newlines/tabs/control chars to single spaces so the chip is one clean line", () => {
    const chip = textChip("a\tb\nc\rd\ne");
    expect(chip).not.toMatch(/\p{Cc}/u); // no stray control characters
    expect(chip).toBe("[a b c d e...3 Lines...]");
  });

  it("replaces square brackets in the preview so a chip never breaks or fakes token grammar", () => {
    const chip = textChip("a[Image #1]b\nc");
    // Interior (between the outer delimiters) must contain no raw brackets.
    expect(chip.slice(1, -1)).not.toContain("[");
    expect(chip.slice(1, -1)).not.toContain("]");
  });
});

describe("registry — chip keying, dedupe, and image counter", () => {
  it("returns a preview chip and stores the full content under it", () => {
    const registry = createPasteRegistry();
    const text = "first\nsecond\nthird";
    const chip = registerPastedText(registry, text);
    expect(chip).toBe(textChip(text));
    expect(registry.texts.get(chip)).toBe(text);
  });

  it("reuses the same chip when identical content is pasted twice", () => {
    const registry = createPasteRegistry();
    const text = "same\nblock";
    const a = registerPastedText(registry, text);
    const b = registerPastedText(registry, text);
    expect(a).toBe(b);
    expect(registry.texts.size).toBe(1);
  });

  it("disambiguates two DIFFERENT pastes that render an identical preview", () => {
    const registry = createPasteRegistry();
    const one = "HEADHEADHEAD\nMIDDLE_ONE\nTAILTAILTAIL";
    const two = "HEADHEADHEAD\nMIDDLE_TWO\nTAILTAILTAIL"; // same head/tail/line-count
    const chip1 = registerPastedText(registry, one);
    const chip2 = registerPastedText(registry, two);
    expect(chip1).not.toBe(chip2);
    expect(registry.texts.get(chip1)).toBe(one);
    expect(registry.texts.get(chip2)).toBe(two);
    expect(chip2).toContain("(2)");
  });

  it("numbers image tokens starting at 1, independently of text pastes", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "a\nb"); // does not touch the image counter
    expect(
      registerPastedImage(registry, {
        path: "/tmp/a.png",
        mediaType: "image/png",
      }),
    ).toBe("[Image #1]");
    expect(
      registerPastedImage(registry, {
        path: "/tmp/b.png",
        mediaType: "image/png",
      }),
    ).toBe("[Image #2]");
  });

  it("resetPasteRegistry clears entries and restarts the image counter at 1", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "x\ny");
    registerPastedImage(registry, {
      path: "/tmp/a.png",
      mediaType: "image/png",
    });
    resetPasteRegistry(registry);
    expect(registry.texts.size).toBe(0);
    expect(registry.images.size).toBe(0);
    expect(
      registerPastedImage(registry, {
        path: "/tmp/c.png",
        mediaType: "image/png",
      }),
    ).toBe("[Image #1]");
  });

  it("imageToken formats the exact grammar (space before #)", () => {
    expect(imageToken(7)).toBe("[Image #7]");
  });
});

describe("tokenEndingAt / tokenStartingAt — atomic deletion spans", () => {
  it("finds a text chip ending exactly at the cursor", () => {
    const registry = createPasteRegistry();
    const chip = registerPastedText(registry, "alpha\nbeta");
    const text = `see ${chip} please`;
    const pos = `see ${chip}`.length;
    expect(tokenEndingAt(registry, text, pos)).toEqual({ start: 4, end: pos });
  });

  it("finds an image token ending exactly at the cursor", () => {
    const registry = createPasteRegistry();
    registerPastedImage(registry, {
      path: "/tmp/a.png",
      mediaType: "image/png",
    });
    const text = "look [Image #1]";
    expect(tokenEndingAt(registry, text, text.length)).toEqual({
      start: 5,
      end: text.length,
    });
  });

  it("returns null when the cursor is mid-chip, not at its end", () => {
    const registry = createPasteRegistry();
    const chip = registerPastedText(registry, "a\nb");
    expect(tokenEndingAt(registry, chip, chip.length - 1)).toBeNull();
  });

  it("returns null when there is no token immediately before the cursor", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "a\nb");
    expect(tokenEndingAt(registry, "plain text", 5)).toBeNull();
  });

  it("finds a chip starting exactly at the cursor (forward delete)", () => {
    const registry = createPasteRegistry();
    const chip = registerPastedText(registry, "one\ntwo");
    const text = `${chip} trailing`;
    expect(tokenStartingAt(registry, text, 0)).toEqual({
      start: 0,
      end: chip.length,
    });
  });

  it("returns null when no token starts at the cursor", () => {
    const registry = createPasteRegistry();
    registerPastedText(registry, "a\nb");
    expect(tokenStartingAt(registry, "no tokens here", 3)).toBeNull();
  });
});

describe("dropTokenAt — removing the registry entry for a deleted token", () => {
  it("drops the matching text chip", () => {
    const registry = createPasteRegistry();
    const chip = registerPastedText(registry, "full\ncontent");
    dropTokenAt(registry, chip, { start: 0, end: chip.length });
    expect(registry.texts.has(chip)).toBe(false);
  });

  it("drops the matching image entry", () => {
    const registry = createPasteRegistry();
    registerPastedImage(registry, {
      path: "/tmp/a.png",
      mediaType: "image/png",
    });
    const text = "[Image #1]";
    dropTokenAt(registry, text, { start: 0, end: text.length });
    expect(registry.images.has(1)).toBe(false);
  });

  it("is a no-op for a span that isn't a recognized token", () => {
    const registry = createPasteRegistry();
    const chip = registerPastedText(registry, "kept\nvalue");
    dropTokenAt(registry, "not a token", { start: 0, end: 3 });
    expect(registry.texts.get(chip)).toBe("kept\nvalue");
  });
});

describe("pruneMissingTokens — the 'at minimum, drop at submit' contract", () => {
  it("drops entries whose token no longer appears intact in the buffer", () => {
    const registry = createPasteRegistry();
    const gone = registerPastedText(registry, "gone\nblock");
    const kept = registerPastedText(registry, "kept\nblock");
    // The first chip was mangled by mid-token editing and no longer reads intact.
    pruneMissingTokens(
      registry,
      `some ${gone.slice(0, 4)} mangled and ${kept} intact`,
    );
    expect(registry.texts.has(gone)).toBe(false);
    expect(registry.texts.get(kept)).toBe("kept\nblock");
  });

  it("leaves intact entries alone", () => {
    const registry = createPasteRegistry();
    const chip = registerPastedText(registry, "content\nhere");
    pruneMissingTokens(registry, `${chip} still here`);
    expect(registry.texts.get(chip)).toBe("content\nhere");
  });
});

describe("expandPasteSubmission — the model-bound expansion", () => {
  it("expands a single text chip inline", () => {
    const registry = createPasteRegistry();
    const chip = registerPastedText(
      registry,
      "the FULL pasted body\nacross lines",
    );
    const result = expandPasteSubmission(registry, `please review ${chip} now`);
    expect(result.expandedText).toBe(
      "please review the FULL pasted body\nacross lines now",
    );
    expect(result.images).toEqual([]);
  });

  it("expands multiple text chips in order", () => {
    const registry = createPasteRegistry();
    const a = registerPastedText(registry, "AAA\nA2");
    const b = registerPastedText(registry, "BBB\nB2");
    const result = expandPasteSubmission(registry, `${a} then ${b}`);
    expect(result.expandedText).toBe("AAA\nA2 then BBB\nB2");
  });

  it("expands two same-preview chips to their own distinct content", () => {
    const registry = createPasteRegistry();
    const one = "HEADHEADHEAD\nMIDDLE_ONE\nTAILTAILTAIL";
    const two = "HEADHEADHEAD\nMIDDLE_TWO\nTAILTAILTAIL";
    const chip1 = registerPastedText(registry, one);
    const chip2 = registerPastedText(registry, two);
    const result = expandPasteSubmission(registry, `${chip1} and ${chip2}`);
    expect(result.expandedText).toBe(`${one} and ${two}`);
  });

  it("replaces an image token with a literal note and lists the attachment", () => {
    const registry = createPasteRegistry();
    const attachment = { path: "/tmp/shot.png", mediaType: "image/png" };
    registerPastedImage(registry, attachment);
    const result = expandPasteSubmission(
      registry,
      "what's wrong here: [Image #1]",
    );
    expect(result.expandedText).toBe("what's wrong here: (attached image)");
    expect(result.images).toEqual([attachment]);
  });

  it("collects multiple images in the order they appear in the text, not registration order", () => {
    const registry = createPasteRegistry();
    const first = { path: "/tmp/1.png", mediaType: "image/png" };
    const second = { path: "/tmp/2.png", mediaType: "image/png" };
    registerPastedImage(registry, first); // #1
    registerPastedImage(registry, second); // #2
    const result = expandPasteSubmission(
      registry,
      "[Image #2] before [Image #1]",
    );
    expect(result.images).toEqual([second, first]);
  });

  it("handles a mix of text and image tokens together", () => {
    const registry = createPasteRegistry();
    const chip = registerPastedText(registry, "stack\ntrace here");
    registerPastedImage(registry, {
      path: "/tmp/a.png",
      mediaType: "image/png",
    });
    const result = expandPasteSubmission(registry, `${chip} and [Image #1]`);
    expect(result.expandedText).toBe("stack\ntrace here and (attached image)");
    expect(result.images).toHaveLength(1);
  });

  it("leaves a token with no registry entry as literal text (never silently dropped)", () => {
    const registry = createPasteRegistry();
    const result = expandPasteSubmission(
      registry,
      "please handle ticket [Image #99]",
    );
    expect(result.expandedText).toBe("please handle ticket [Image #99]");
    expect(result.images).toEqual([]);
  });

  it("is a no-op on plain text with no tokens at all", () => {
    const registry = createPasteRegistry();
    const result = expandPasteSubmission(registry, "just a normal prompt");
    expect(result).toEqual({
      expandedText: "just a normal prompt",
      images: [],
    });
  });

  it("prunes stale entries as part of expansion", () => {
    const registry = createPasteRegistry();
    const chip = registerPastedText(registry, "orphaned\nblock"); // never referenced below
    expandPasteSubmission(registry, "no tokens in this text");
    expect(registry.texts.has(chip)).toBe(false);
  });
});
