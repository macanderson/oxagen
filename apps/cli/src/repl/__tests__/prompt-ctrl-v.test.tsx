/**
 * The double-Ctrl-V open-in-editor gesture on the prompt bar.
 *
 * Single Ctrl-V stays the image-paste probe (fire-and-forget, inert when the
 * clipboard has no image); a second press within CTRL_V_EDITOR_WINDOW_MS fires
 * `onOpenLastTouched`. Any other key breaks the chain — the same disarm rule
 * as the files panel's double-Ctrl-O.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import {
  PromptInput,
  resolveCtrlV,
  CTRL_V_EDITOR_WINDOW_MS,
} from "../components.js";

const CTRL_V = "\x16";

/** Poll until `cond` holds — Ink delivers stdin/state asynchronously. */
async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error("until(): condition not met before deadline");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("resolveCtrlV — the pure double-press decision", () => {
  it("arms on the first press", () => {
    expect(resolveCtrlV(null, 1_000)).toBe("arm");
  });

  it("opens on a second press within the window", () => {
    expect(resolveCtrlV(1_000, 1_000 + CTRL_V_EDITOR_WINDOW_MS)).toBe("open");
    expect(resolveCtrlV(1_000, 1_001)).toBe("open");
  });

  it("re-arms once the window has lapsed", () => {
    expect(resolveCtrlV(1_000, 1_000 + CTRL_V_EDITOR_WINDOW_MS + 1)).toBe(
      "arm",
    );
  });
});

describe("PromptInput — double-Ctrl-V opens the editor", () => {
  it("fires onOpenLastTouched on a rapid double press", async () => {
    const onOpen = vi.fn();
    const { stdin } = render(
      <PromptInput
        onSubmit={vi.fn()}
        busy={false}
        onOpenLastTouched={onOpen}
        readClipboardImage={async () => null}
      />,
    );
    // Ink's useInput subscribes after commit — re-press inside the poll
    // rather than fire-and-forget so a pre-subscription press can't starve
    // the test. Each iteration is one clean double-press inside the window.
    await until(() => {
      stdin.write(CTRL_V);
      stdin.write(CTRL_V);
      return onOpen.mock.calls.length > 0;
    });
    expect(onOpen).toHaveBeenCalled();
  });

  it("any other key between presses breaks the chain", async () => {
    const onOpen = vi.fn();
    const { stdin, lastFrame } = render(
      <PromptInput
        onSubmit={vi.fn()}
        busy={false}
        onOpenLastTouched={onOpen}
        readClipboardImage={async () => null}
      />,
    );
    // Prime the input (proves useInput is live) before the real assertion.
    await until(() => {
      stdin.write("a");
      return (lastFrame() ?? "").includes("a");
    });
    stdin.write(CTRL_V);
    stdin.write("b");
    await until(() => (lastFrame() ?? "").includes("b"));
    stdin.write(CTRL_V); // chain was broken — this is a fresh FIRST press
    // Give the (would-be) callback a beat to fire, then assert it never did.
    await new Promise((r) => setTimeout(r, 50));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("stays inert without the onOpenLastTouched prop", async () => {
    const { stdin, lastFrame } = render(
      <PromptInput
        onSubmit={vi.fn()}
        busy={false}
        readClipboardImage={async () => null}
      />,
    );
    await until(() => {
      stdin.write("x");
      return (lastFrame() ?? "").includes("x");
    });
    stdin.write(CTRL_V);
    stdin.write(CTRL_V);
    await new Promise((r) => setTimeout(r, 50));
    // No crash, buffer intact — the double press was a no-op.
    expect(lastFrame() ?? "").toContain("x");
  });
});
