/**
 * PromptInput paste UX — proves the whole loop end to end through real ink
 * stdin: a single-line bracketed paste inserts inline in full; a MULTI-LINE
 * paste collapses to a `[first 12…N Lines…last 12]` preview chip; Ctrl-V IMAGE
 * paste via the injectable `readClipboardImage` prop collapses to `[Image #N]`;
 * atomic token deletion; per-prompt registry reset; and — the whole point —
 * that submitting expands every placeholder back to full content for the model
 * while the bar itself only ever showed the compact chip.
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { PromptInput } from "../components.js";
import { textChip, type PasteSubmission } from "../paste.js";
import type { PastedImageAttachment } from "../../lib/clipboard-image.js";

/** Ink delivers stdin to useInput/usePaste asynchronously; give state a beat to settle. */
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Raw terminal byte sequences, built from char codes so the source stays free
// of invisible control characters (same convention as components.test.tsx).
const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127); // DEL, what real terminals send for ⌫
const CTRL_V = String.fromCharCode(22); // SYN — the raw byte a terminal sends for Ctrl-V
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** Wrap `text` as a single bracketed-paste stdin chunk, exactly like a real terminal. */
const bracketedPaste = (text: string): string =>
  `${PASTE_START}${text}${PASTE_END}`;

/** A multi-line pasted blob (collapses to a preview chip). */
const bigPaste = (label: string): string =>
  Array.from(
    { length: 10 },
    (_, i) => `${label} line ${i} ${"x".repeat(50)}`,
  ).join("\n");

interface Submission {
  text: string;
  paste?: PasteSubmission;
}

function captureSubmits(): {
  onSubmit: (text: string, paste?: PasteSubmission) => void;
  calls: Submission[];
} {
  const calls: Submission[] = [];
  return { onSubmit: (text, paste) => calls.push({ text, paste }), calls };
}

describe("PromptInput — text paste (bracketed paste → usePaste)", () => {
  it("inserts a single-line paste inline, unchanged, however long", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} />,
    );
    stdin.write(bracketedPaste("a single long line without any newline"));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("a single long line without any newline");
    expect(frame).not.toContain("Lines...");
  });

  it("collapses a multi-line paste to its preview chip", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} />,
    );
    const big = bigPaste("A");
    stdin.write(bracketedPaste(big));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain(textChip(big));
    expect(frame).toContain("10 Lines...");
    expect(frame).not.toContain(big);
  });

  it("shows a distinct preview chip for a second multi-line paste in the same prompt", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} />,
    );
    const a = bigPaste("A");
    const b = bigPaste("B");
    stdin.write(bracketedPaste(a));
    await tick();
    stdin.write(" and "); // plain typing between the two pastes
    await tick();
    stdin.write(bracketedPaste(b));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain(textChip(a));
    expect(frame).toContain("and");
    expect(frame).toContain(textChip(b));
    expect(textChip(a)).not.toBe(textChip(b));
  });

  it("expands every placeholder back to full content, in order, on submit", async () => {
    const captured = captureSubmits();
    const { stdin } = render(
      <PromptInput onSubmit={captured.onSubmit} busy={false} />,
    );
    const a = bigPaste("A");
    const b = bigPaste("B");
    stdin.write(bracketedPaste(a));
    await tick();
    stdin.write(" and ");
    await tick();
    stdin.write(bracketedPaste(b));
    await tick();
    stdin.write("\r");
    await tick();

    expect(captured.calls).toHaveLength(1);
    const submission = captured.calls[0]!;
    expect(submission.text).toBe(`${textChip(a)} and ${textChip(b)}`);
    expect(submission.paste).toBeDefined();
    expect(submission.paste!.expandedText).toBe(`${a} and ${b}`);
    expect(submission.paste!.images).toEqual([]);
  });

  it("passes no `paste` argument when the submission held no placeholders", async () => {
    const captured = captureSubmits();
    const { stdin } = render(
      <PromptInput onSubmit={captured.onSubmit} busy={false} />,
    );
    stdin.write("just a normal short prompt");
    await tick();
    stdin.write("\r");
    await tick();
    expect(captured.calls).toEqual([
      { text: "just a normal short prompt", paste: undefined },
    ]);
  });

  it("re-registers pastes fresh after submit (no stale registry across prompts)", async () => {
    const captured = captureSubmits();
    const { stdin } = render(
      <PromptInput onSubmit={captured.onSubmit} busy={false} />,
    );
    const a = bigPaste("A");
    stdin.write(bracketedPaste(a));
    await tick();
    stdin.write("\r");
    await tick();

    // Second prompt, same content pasted again — must expand on its own, proving
    // the registry was reset AND freshly re-populated (not left stale or empty).
    stdin.write(bracketedPaste(a));
    await tick();
    stdin.write("\r");
    await tick();

    expect(captured.calls).toHaveLength(2);
    expect(captured.calls[1]!.paste!.expandedText).toBe(a);
  });

  it("clearing the registry via inject (e.g. queue recall) drops the old chip", async () => {
    const captured = captureSubmits();
    const a = bigPaste("A");
    const b = bigPaste("B");
    const { lastFrame, stdin, rerender } = render(
      <PromptInput
        onSubmit={captured.onSubmit}
        busy={false}
        inject={{ text: "", nonce: 0 }}
      />,
    );
    stdin.write(bracketedPaste(a));
    await tick();

    // Parent wholesale-replaces the buffer (recall/task-edit/clear) WITHOUT a submit.
    rerender(
      <PromptInput
        onSubmit={captured.onSubmit}
        busy={false}
        inject={{ text: "recalled text", nonce: 1 }}
      />,
    );
    await tick();

    stdin.write(bracketedPaste(b));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain(textChip(b));
    expect(frame).not.toContain(textChip(a)); // the old registry entry was reset
  });
});

describe("PromptInput — atomic token deletion", () => {
  it("backspacing right after a chip deletes the WHOLE chip in one keystroke", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} />,
    );
    const big = bigPaste("A");
    stdin.write(bracketedPaste(big));
    await tick();
    expect(lastFrame() ?? "").toContain(textChip(big));

    stdin.write(BACKSPACE);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain(textChip(big));
    expect(frame).not.toContain("Lines..."); // no partial chip left dangling
  });

  it("dropping a chip's registry entry means retyping the same chip by hand is NOT expanded", async () => {
    const captured = captureSubmits();
    const { stdin } = render(
      <PromptInput onSubmit={captured.onSubmit} busy={false} />,
    );
    const big = bigPaste("SECRET");
    const chip = textChip(big);
    stdin.write(bracketedPaste(big));
    await tick();
    stdin.write(BACKSPACE); // atomic backspace removes the chip AND its registry entry
    await tick();

    // Hand-type a string that LOOKS like the chip that was just deleted.
    stdin.write(chip);
    await tick();
    stdin.write("\r");
    await tick();

    const submission = captured.calls[0]!;
    // No live registry entry anymore, so it is NOT expanded — proving the
    // deletion actually dropped the stored content, not just hid it.
    expect(submission.paste).toBeUndefined();
    expect(submission.text).toBe(chip);
  });
});

describe("PromptInput — image paste (Ctrl-V + injectable clipboard reader)", () => {
  const fakeAttachment: PastedImageAttachment = {
    path: "/tmp/oxagen-paste-test/shot.png",
    mediaType: "image/png",
  };

  it("Ctrl-V with an image on the clipboard inserts [Image #1] and stores its path", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput
        onSubmit={() => {}}
        busy={false}
        readClipboardImage={async () => fakeAttachment}
      />,
    );
    stdin.write(CTRL_V);
    await tick(50);
    expect(lastFrame() ?? "").toContain("[Image #1]");
  });

  it("submitting after an image paste produces an image content part with the stored path", async () => {
    const captured = captureSubmits();
    const { stdin } = render(
      <PromptInput
        onSubmit={captured.onSubmit}
        busy={false}
        readClipboardImage={async () => fakeAttachment}
      />,
    );
    stdin.write("check this out: ");
    await tick();
    stdin.write(CTRL_V);
    await tick(50);
    stdin.write("\r");
    await tick();

    const submission = captured.calls[0]!;
    expect(submission.text).toBe("check this out: [Image #1]");
    expect(submission.paste).toBeDefined();
    expect(submission.paste!.images).toEqual([fakeAttachment]);
    expect(submission.paste!.expandedText).toBe(
      "check this out: (attached image)",
    );
  });

  it("numbers image tokens independently from text pastes", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput
        onSubmit={() => {}}
        busy={false}
        readClipboardImage={async () => fakeAttachment}
      />,
    );
    const big = bigPaste("A");
    stdin.write(bracketedPaste(big)); // preview chip
    await tick();
    stdin.write(CTRL_V); // [Image #1] — independent counter
    await tick(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(textChip(big));
    expect(frame).toContain("[Image #1]");
  });

  it("gracefully no-ops when there is no image on the clipboard", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput
        onSubmit={() => {}}
        busy={false}
        readClipboardImage={async () => null}
      />,
    );
    stdin.write("typed before");
    await tick();
    stdin.write(CTRL_V);
    await tick(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("typed before");
    expect(frame).not.toContain("[Image #");
  });

  it("gracefully no-ops when the clipboard reader itself is unavailable (no pngpaste/osascript)", async () => {
    // Simulates the real default's degrade path (unsupported platform, every
    // tool missing) without shelling out — that path is unit-tested directly
    // in lib/__tests__/clipboard-image.test.ts.
    const { lastFrame, stdin } = render(
      <PromptInput
        onSubmit={() => {}}
        busy={false}
        readClipboardImage={async () => null}
      />,
    );
    stdin.write(CTRL_V);
    await tick(50);
    expect(lastFrame() ?? "").not.toContain("[Image #");
  });
});
