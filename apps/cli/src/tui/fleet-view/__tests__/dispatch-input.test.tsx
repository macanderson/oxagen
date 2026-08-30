/**
 * Ink tests for the fleet dispatch line: typing edits the buffer, Enter
 * dispatches the trimmed text and clears it, an empty/whitespace submit is a
 * no-op, backspace erases, and control chords are ignored (they belong to the
 * app-level handler). Poll-with-deadline throughout; never fixed sleeps.
 */
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { DispatchInput } from "../dispatch-input.js";

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

async function until(
  cond: () => boolean,
  timeoutMs = 3000,
  frame?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      const tail = frame ? `\n--- last frame ---\n${frame()}` : "";
      throw new Error(`until(): condition not met in time${tail}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const PLACEHOLDER = "submit a prompt using enter to dispatch an agent";

const mount = (onDispatch: (text: string) => void = () => {}) => {
  const r = render(<DispatchInput onDispatch={onDispatch} />);
  const plain = (): string => strip(r.lastFrame() ?? "");
  return { ...r, plain };
};

describe("DispatchInput", () => {
  it("shows the pointer, cursor block, and placeholder while empty", async () => {
    const { plain, unmount } = mount();
    await until(() => plain().includes(PLACEHOLDER), 3000, plain);
    expect(plain()).toContain("❯");
    expect(plain()).toContain("█");
    unmount();
  });

  it("typing edits the buffer and hides the placeholder", async () => {
    const { stdin, plain, unmount } = mount();
    await until(() => plain().length > 0);
    stdin.write("fix the login bug");
    await until(() => plain().includes("fix the login bug"), 3000, plain);
    expect(plain()).not.toContain(PLACEHOLDER);
    unmount();
  });

  it("enter dispatches the trimmed text and clears back to the placeholder", async () => {
    const onDispatch = vi.fn();
    const { stdin, plain, unmount } = mount(onDispatch);
    await until(() => plain().length > 0);
    stdin.write("  ship it  ");
    await until(() => plain().includes("ship it"), 3000, plain);
    stdin.write("\r");
    await until(() => onDispatch.mock.calls.length === 1, 3000, plain);
    expect(onDispatch).toHaveBeenCalledWith("ship it");
    // The buffer clears, so the placeholder returns.
    await until(() => plain().includes(PLACEHOLDER), 3000, plain);
    unmount();
  });

  it("enter on an empty or whitespace-only buffer dispatches nothing", async () => {
    const onDispatch = vi.fn();
    const { stdin, plain, unmount } = mount(onDispatch);
    await until(() => plain().length > 0);
    stdin.write("\r");
    stdin.write("   ");
    await until(() => !plain().includes(PLACEHOLDER), 3000, plain);
    stdin.write("\r");
    // Give the handler a beat to (wrongly) fire before asserting it did not.
    await new Promise((r) => setTimeout(r, 60));
    expect(onDispatch).not.toHaveBeenCalled();
    unmount();
  });

  it("backspace erases the last character", async () => {
    const { stdin, plain, unmount } = mount();
    await until(() => plain().length > 0);
    stdin.write("ab");
    await until(() => plain().includes("ab"), 3000, plain);
    stdin.write("\u007f"); // DEL — ink reports key.delete/backspace
    await until(
      () => !plain().includes("ab") && plain().includes("a"),
      3000,
      plain,
    );
    unmount();
  });

  it("ignores control chords instead of inserting them", async () => {
    const onDispatch = vi.fn();
    const { stdin, plain, unmount } = mount(onDispatch);
    await until(() => plain().length > 0);
    stdin.write("\u0014"); // Ctrl-T — the app-level toggle, not input
    stdin.write("ok");
    await until(() => plain().includes("ok"), 3000, plain);
    // The buffer holds exactly "ok": submit and observe what was dispatched.
    stdin.write("\r");
    await until(() => onDispatch.mock.calls.length === 1, 3000, plain);
    expect(onDispatch).toHaveBeenCalledWith("ok");
    unmount();
  });
});
