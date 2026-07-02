/**
 * PromptInput paste UX — proves the whole loop end to end through real ink
 * stdin: bracketed-paste TEXT collapsing to `[CopiedText-N]` above the
 * threshold (small pastes insert inline), Ctrl-V IMAGE paste via the
 * injectable `readClipboardImage` prop collapsing to `[Image#N]`, atomic
 * token deletion, per-prompt counter reset, and — the whole point — that
 * submitting expands every placeholder back to full content for the model
 * while the bar itself only ever showed the compact token.
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import { PromptInput } from "../components.js";
import type { PasteSubmission } from "../paste.js";
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
const bracketedPaste = (text: string): string => `${PASTE_START}${text}${PASTE_END}`;

/** A pasted blob comfortably over both collapse thresholds (chars AND lines). */
const bigPaste = (label: string): string =>
  Array.from({ length: 10 }, (_, i) => `${label} line ${i} ${"x".repeat(50)}`).join("\n");

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
  it("inserts a small paste inline, unchanged", async () => {
    const { lastFrame, stdin } = render(<PromptInput onSubmit={() => {}} busy={false} />);
    stdin.write(bracketedPaste("short paste"));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("short paste");
    expect(frame).not.toContain("[CopiedText");
  });

  it("collapses a paste over the threshold to [CopiedText-1]", async () => {
    const { lastFrame, stdin } = render(<PromptInput onSubmit={() => {}} busy={false} />);
    const big = bigPaste("A");
    stdin.write(bracketedPaste(big));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[CopiedText-1]");
    expect(frame).not.toContain(big);
  });

  it("numbers a second large paste in the same prompt [CopiedText-2]", async () => {
    const { lastFrame, stdin } = render(<PromptInput onSubmit={() => {}} busy={false} />);
    stdin.write(bracketedPaste(bigPaste("A")));
    await tick();
    stdin.write(" and "); // plain typing between the two pastes
    await tick();
    stdin.write(bracketedPaste(bigPaste("B")));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[CopiedText-1]");
    expect(frame).toContain("and");
    expect(frame).toContain("[CopiedText-2]");
  });

  it("expands every placeholder back to full content, in order, on submit", async () => {
    const captured = captureSubmits();
    const { stdin } = render(<PromptInput onSubmit={captured.onSubmit} busy={false} />);
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
    expect(submission.text).toBe("[CopiedText-1] and [CopiedText-2]");
    expect(submission.paste).toBeDefined();
    expect(submission.paste!.expandedText).toBe(`${a} and ${b}`);
    expect(submission.paste!.images).toEqual([]);
  });

  it("passes no `paste` argument when the submission held no placeholders", async () => {
    const captured = captureSubmits();
    const { stdin } = render(<PromptInput onSubmit={captured.onSubmit} busy={false} />);
    stdin.write("just a normal short prompt");
    await tick();
    stdin.write("\r");
    await tick();
    expect(captured.calls).toEqual([{ text: "just a normal short prompt", paste: undefined }]);
  });

  it("resets the counter to 1 for the next prompt after submit", async () => {
    const captured = captureSubmits();
    const { lastFrame, stdin } = render(<PromptInput onSubmit={captured.onSubmit} busy={false} />);
    stdin.write(bracketedPaste(bigPaste("A")));
    await tick();
    stdin.write("\r");
    await tick();

    // Second prompt, fresh paste — numbering must restart at 1, not continue to 2.
    stdin.write(bracketedPaste(bigPaste("B")));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[CopiedText-1]");
    expect(frame).not.toContain("[CopiedText-2]");
  });

  it("clearing counters via inject (e.g. queue recall) restarts numbering at 1", async () => {
    const captured = captureSubmits();
    const { lastFrame, stdin, rerender } = render(
      <PromptInput onSubmit={captured.onSubmit} busy={false} inject={{ text: "", nonce: 0 }} />,
    );
    stdin.write(bracketedPaste(bigPaste("A")));
    await tick();

    // Parent wholesale-replaces the buffer (recall/task-edit/clear) WITHOUT a submit.
    rerender(
      <PromptInput onSubmit={captured.onSubmit} busy={false} inject={{ text: "recalled text", nonce: 1 }} />,
    );
    await tick();

    stdin.write(bracketedPaste(bigPaste("B")));
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[CopiedText-1]"); // not [CopiedText-2] — the old registry was reset
  });
});

describe("PromptInput — atomic token deletion", () => {
  it("backspacing right after a token deletes the WHOLE token in one keystroke", async () => {
    const { lastFrame, stdin } = render(<PromptInput onSubmit={() => {}} busy={false} />);
    stdin.write(bracketedPaste(bigPaste("A")));
    await tick();
    expect(lastFrame() ?? "").toContain("[CopiedText-1]");

    stdin.write(BACKSPACE);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("[CopiedText-1]");
    expect(frame).not.toContain("CopiedText"); // no partial "[CopiedText-" left dangling
  });

  it("dropping a token's registry entry means retyping the same text by hand is NOT expanded", async () => {
    const captured = captureSubmits();
    const { stdin } = render(<PromptInput onSubmit={captured.onSubmit} busy={false} />);
    stdin.write(bracketedPaste(bigPaste("SECRET")));
    await tick();
    stdin.write(BACKSPACE); // atomic backspace removes the token AND its registry entry
    await tick();

    // Hand-type a string that LOOKS like the token that was just deleted.
    stdin.write("[CopiedText-1]");
    await tick();
    stdin.write("\r");
    await tick();

    const submission = captured.calls[0]!;
    // No live registry entry for id 1 anymore, so it is NOT expanded — proving
    // the deletion actually dropped the stored content, not just hid it.
    expect(submission.paste).toBeUndefined();
    expect(submission.text).toBe("[CopiedText-1]");
  });
});

describe("PromptInput — image paste (Ctrl-V + injectable clipboard reader)", () => {
  const fakeAttachment: PastedImageAttachment = {
    path: "/tmp/oxagen-paste-test/shot.png",
    mediaType: "image/png",
  };

  it("Ctrl-V with an image on the clipboard inserts [Image#1] and stores its path", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} readClipboardImage={async () => fakeAttachment} />,
    );
    stdin.write(CTRL_V);
    await tick(50);
    expect(lastFrame() ?? "").toContain("[Image#1]");
  });

  it("submitting after an image paste produces an image content part with the stored path", async () => {
    const captured = captureSubmits();
    const { stdin } = render(
      <PromptInput onSubmit={captured.onSubmit} busy={false} readClipboardImage={async () => fakeAttachment} />,
    );
    stdin.write("check this out: ");
    await tick();
    stdin.write(CTRL_V);
    await tick(50);
    stdin.write("\r");
    await tick();

    const submission = captured.calls[0]!;
    expect(submission.text).toBe("check this out: [Image#1]");
    expect(submission.paste).toBeDefined();
    expect(submission.paste!.images).toEqual([fakeAttachment]);
    expect(submission.paste!.expandedText).toBe("check this out: (attached image)");
  });

  it("numbers image tokens independently from text tokens", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} readClipboardImage={async () => fakeAttachment} />,
    );
    stdin.write(bracketedPaste(bigPaste("A"))); // [CopiedText-1]
    await tick();
    stdin.write(CTRL_V); // [Image#1] — independent counter
    await tick(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[CopiedText-1]");
    expect(frame).toContain("[Image#1]");
  });

  it("gracefully no-ops when there is no image on the clipboard", async () => {
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} readClipboardImage={async () => null} />,
    );
    stdin.write("typed before");
    await tick();
    stdin.write(CTRL_V);
    await tick(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("typed before");
    expect(frame).not.toContain("[Image#");
  });

  it("gracefully no-ops when the clipboard reader itself is unavailable (no pngpaste/osascript)", async () => {
    // Simulates the real default's degrade path (unsupported platform, every
    // tool missing) without shelling out — that path is unit-tested directly
    // in lib/__tests__/clipboard-image.test.ts.
    const { lastFrame, stdin } = render(
      <PromptInput onSubmit={() => {}} busy={false} readClipboardImage={async () => null} />,
    );
    stdin.write(CTRL_V);
    await tick(50);
    expect(lastFrame() ?? "").not.toContain("[Image#");
  });
});
