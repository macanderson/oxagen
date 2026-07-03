/**
 * Regression: the full-screen TUI arms SGR mouse tracking (modes 1000/1006) for
 * wheel scroll, so the terminal reports every click/drag/release to stdin as an
 * escape sequence. Those reports are NOT typed text — PromptInput must drop them
 * so a click, drag, or scroll never sprays escape codes into the prompt buffer
 * (the "input fills with garbage on mouse" bug).
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { PromptInput } from "../components.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

// Built from char codes so the source has no invisible control characters
// (matches the convention in prompt-input-editing.test.tsx / components.test.tsx).
const ESC = String.fromCharCode(27);
// The full-screen TUI arms SGR mode 1006, so every report uses the SGR form
// `ESC[<Cb;Cx;Cy(M|m)` — the legacy X10 form never occurs and is not exercised.
const SGR_CLICK = `${ESC}[<0;40;10M`; // left button press at col 40, row 10
const SGR_RELEASE = `${ESC}[<0;40;10m`; // release (lowercase terminator)
const SGR_DRAG = `${ESC}[<32;41;10M`; // motion-with-button

describe("PromptInput — mouse reports never enter the buffer", () => {
  it("clicks/drags/releases between keystrokes leave a clean buffer", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("ab");
    await tick();
    stdin.write(SGR_CLICK);
    await tick();
    stdin.write(SGR_DRAG);
    await tick();
    stdin.write(SGR_RELEASE);
    await tick();
    stdin.write("c");
    await tick();
    stdin.write("\r");
    await tick();
    // If the guard were missing, the submitted value would contain the raw
    // escape-sequence bytes between "ab" and "c".
    expect(calls).toEqual(["abc"]);
    unmount();
  });

  it("a bare wheel-scroll report submits nothing garbled", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write(`${ESC}[<64;10;5M`); // wheel-up report
    await tick();
    stdin.write(`${ESC}[<65;10;5M`); // wheel-down report
    await tick();
    stdin.write("hello");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["hello"]);
    unmount();
  });
});
