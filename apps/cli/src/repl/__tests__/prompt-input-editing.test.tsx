/**
 * Proves PromptInput's cursor-aware editing: Left/Right/Home/End move a real
 * cursor position instead of always acting at the end of the buffer, and
 * Ctrl-J inserts a newline (basic multiline) rather than submitting — the
 * buffer previously only supported "type, backspace the last char, Enter".
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { PromptInput } from "../components.js";

/**
 * Ink delivers stdin to useInput asynchronously, so give state a beat to
 * settle before asserting (matches the convention in components.test.tsx).
 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

// Raw terminal byte sequences, built from char codes so the source stays free
// of invisible control characters (matches components.test.tsx's ESC/ARROW_DOWN).
const ESC = String.fromCharCode(27);
const ARROW_LEFT = `${ESC}[D`;
const ARROW_RIGHT = `${ESC}[C`;
const HOME = `${ESC}[H`;
const END = `${ESC}[F`;
const CTRL_J = String.fromCharCode(10); // bare linefeed — the newline keybinding

describe("PromptInput — cursor movement", () => {
  it("Left arrow moves the cursor so a typed character inserts mid-string, not at the end", async () => {
    // Submit (rather than read the rendered frame) so the assertion checks
    // the plain buffer content, not the ANSI reverse-video wrapping the
    // renderer puts around whichever character the cursor currently sits on.
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("ac");
    await tick();
    stdin.write(ARROW_LEFT); // cursor between 'a' and 'c'
    await tick();
    stdin.write("b");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["abc"]);
    unmount();
  });

  it("Right arrow moves the cursor back toward the end", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("ac");
    await tick();
    stdin.write(ARROW_LEFT);
    await tick();
    stdin.write(ARROW_LEFT); // cursor before 'a'
    await tick();
    stdin.write(ARROW_RIGHT); // back between 'a' and 'c'
    await tick();
    stdin.write("b");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["abc"]);
    unmount();
  });

  it("Right arrow is clamped at the end of the buffer (no overrun)", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("ab");
    await tick();
    stdin.write(ARROW_RIGHT); // already at the end — no-op
    await tick();
    stdin.write(ARROW_RIGHT);
    await tick();
    stdin.write("c");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["abc"]);
    unmount();
  });

  it("Backspace removes the character before the cursor, not always the last one", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("abc");
    await tick();
    stdin.write(ARROW_LEFT); // cursor between 'b' and 'c'
    await tick();
    stdin.write("\x7f"); // backspace — removes 'b'
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["ac"]);
    unmount();
  });

  it("Delete removes the character after the cursor, leaving the cursor in place", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("abc");
    await tick();
    stdin.write(HOME); // cursor before 'a'
    await tick();
    stdin.write(`${ESC}[3~`); // forward delete — removes 'a'
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["bc"]);
    unmount();
  });

  it("Home jumps the cursor to the start and End back to the end", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("bc");
    await tick();
    stdin.write(HOME);
    await tick();
    stdin.write("a"); // inserted at the start
    await tick();
    stdin.write(END);
    await tick();
    stdin.write("d"); // inserted at the end
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["abcd"]);
    unmount();
  });
});

describe("PromptInput — basic multiline (Ctrl-J)", () => {
  it("Ctrl-J inserts a newline without submitting", async () => {
    const calls: string[] = [];
    const { lastFrame, stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("line one");
    await tick();
    stdin.write(CTRL_J);
    await tick();
    stdin.write("line two");
    await tick();
    // Nothing submitted yet — the newline did not act like Enter.
    expect(calls).toEqual([]);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("line one");
    expect(frame).toContain("line two");
    unmount();
  });

  it("Enter submits the full multi-line buffer, newline included", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("line one");
    await tick();
    stdin.write(CTRL_J);
    await tick();
    stdin.write("line two");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["line one\nline two"]);
    unmount();
  });

  it("a newline can be inserted mid-buffer via cursor movement, not just at the end", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput onSubmit={(t) => calls.push(t)} busy={false} />,
    );
    stdin.write("ab");
    await tick();
    stdin.write(ARROW_LEFT); // cursor between 'a' and 'b'
    await tick();
    stdin.write(CTRL_J);
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["a\nb"]);
    unmount();
  });
});
