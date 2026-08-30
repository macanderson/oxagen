/**
 * End-to-end proof that PromptInput's mouse click/drag selection actually
 * works when driven with real SGR mouse byte sequences over stdin — not just
 * mouse-select.ts's pure math in isolation. Mirrors prompt-input-editing.test.tsx's
 * pattern (raw stdin.write() + a settle tick), just with mouse bytes instead
 * of keystrokes.
 */
import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { PromptInput } from "../components.js";
import { textStartColumn } from "../mouse-select.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

const ROW = 10;
// Real glyph width is 2 ("❯ " / "⧗ " / "$ "); the buffer's first character
// always renders at this screen column, matching PromptInput's own math.
const TEXT_START_COL = textStartColumn(2);
/** Screen column of the character at buffer offset `n` (0-based). */
const col = (n: number): number => TEXT_START_COL + n;

/** SGR mouse report: ESC [ < Cb ; Cx ; Cy (M|m). */
const press = (c: number, r: number = ROW): string => `\x1b[<0;${c};${r}M`;
const drag = (c: number, r: number = ROW): string => `\x1b[<32;${c};${r}M`;
const release = (c: number, r: number = ROW): string => `\x1b[<0;${c};${r}m`;

describe("PromptInput — mouse click/drag selection", () => {
  it("click positions the cursor (no drag = no visible selection) — typing inserts there, not at the end", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        mouseRow={ROW}
        mouseEnabled
      />,
    );
    stdin.write("ac");
    await tick();
    stdin.write(press(col(1))); // click between 'a' and 'c'
    await tick();
    stdin.write(release(col(1)));
    await tick();
    stdin.write("b");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["abc"]);
    unmount();
  });

  it("drag selects a range, and Backspace deletes the WHOLE selection in one keystroke", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        mouseRow={ROW}
        mouseEnabled
      />,
    );
    stdin.write("abcdef");
    await tick();
    // Press at offset 1 ('b'), drag to offset 4 (before 'e') -> selects "bcd".
    stdin.write(press(col(1)));
    await tick();
    stdin.write(drag(col(4)));
    await tick();
    stdin.write(release(col(4)));
    await tick();
    stdin.write("\x7f"); // Backspace
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["aef"]);
    unmount();
  });

  it("drag selects a range, and Delete removes the WHOLE selection the same as Backspace", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        mouseRow={ROW}
        mouseEnabled
      />,
    );
    stdin.write("abcdef");
    await tick();
    stdin.write(press(col(1)));
    await tick();
    stdin.write(drag(col(4)));
    await tick();
    stdin.write(release(col(4)));
    await tick();
    stdin.write(`${String.fromCharCode(27)}[3~`); // forward delete
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["aef"]);
    unmount();
  });

  it("typing over a drag-made selection REPLACES it, same as pasting or Backspace-then-type", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        mouseRow={ROW}
        mouseEnabled
      />,
    );
    stdin.write("abcdef");
    await tick();
    stdin.write(press(col(1)));
    await tick();
    stdin.write(drag(col(4)));
    await tick();
    stdin.write(release(col(4)));
    await tick();
    stdin.write("XY");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["aXYef"]);
    unmount();
  });

  it("a backward drag (dragging left of the press) selects the same range as forward", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        mouseRow={ROW}
        mouseEnabled
      />,
    );
    stdin.write("abcdef");
    await tick();
    // Press at offset 4, drag BACK to offset 1 -> same [1,4) "bcd" range.
    stdin.write(press(col(4)));
    await tick();
    stdin.write(drag(col(1)));
    await tick();
    stdin.write(release(col(1)));
    await tick();
    stdin.write("\x7f");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["aef"]);
    unmount();
  });

  it("Left/Right arrow after a drag collapses the selection instead of moving relative to it", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        mouseRow={ROW}
        mouseEnabled
      />,
    );
    stdin.write("abcdef");
    await tick();
    stdin.write(press(col(1)));
    await tick();
    stdin.write(drag(col(4)));
    await tick();
    stdin.write(release(col(4)));
    await tick();
    // Right arrow should clear the selection AND move the cursor — a
    // following Backspace then removes exactly ONE character, not the
    // formerly-selected range.
    stdin.write(`${String.fromCharCode(27)}[C`); // right arrow
    await tick();
    stdin.write("\x7f");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["abcef"]); // only 'd' (just left of the post-arrow cursor) removed
    unmount();
  });

  it("a click on a DIFFERENT row than mouseRow is ignored — never steals a click meant for the transcript/dock", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        mouseRow={ROW}
        mouseEnabled
      />,
    );
    stdin.write("abcdef");
    await tick();
    stdin.write(press(col(1), ROW + 5)); // wrong row
    await tick();
    stdin.write(drag(col(4), ROW + 5));
    await tick();
    stdin.write(release(col(4), ROW + 5));
    await tick();
    // No selection should have formed — Backspace removes just the last char.
    stdin.write("\x7f");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["abcde"]);
    unmount();
  });

  it("mouseEnabled=false ignores mouse bytes entirely — the /mouse toggle's off state", async () => {
    const calls: string[] = [];
    const { stdin, unmount } = render(
      <PromptInput
        onSubmit={(t) => calls.push(t)}
        busy={false}
        mouseRow={ROW}
        mouseEnabled={false}
      />,
    );
    stdin.write("abcdef");
    await tick();
    stdin.write(press(col(1)));
    await tick();
    stdin.write(drag(col(4)));
    await tick();
    stdin.write(release(col(4)));
    await tick();
    stdin.write("\x7f");
    await tick();
    stdin.write("\r");
    await tick();
    expect(calls).toEqual(["abcde"]); // no selection formed — plain single-char backspace
    unmount();
  });
});
