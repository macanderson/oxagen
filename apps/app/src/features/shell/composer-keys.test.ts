// What a key does in the assistant composer under each `enter_to_submit`
// setting, and that an Enter the input method editor owns never sends.
import { describe, expect, it } from "vitest";
import { type ComposerKeyEvent, composerKeyAction } from "./composer-keys";

/** A plain Enter keydown, no modifier held and no composition open, with any field overridden. */
function key(overrides: Partial<ComposerKeyEvent> = {}): ComposerKeyEvent {
  return {
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    keyCode: 13,
    nativeEvent: { isComposing: false },
    ...overrides,
  };
}

const COMPOSING = { nativeEvent: { isComposing: true } };

describe("composerKeyAction with enter_to_submit on", () => {
  it("sends on Enter", () => {
    expect(composerKeyAction(key(), true)).toBe("send");
  });

  it("adds a line on Shift+Enter (negative)", () => {
    expect(composerKeyAction(key({ shiftKey: true }), true)).toBe("newline");
  });

  it("sends on Cmd+Enter and Ctrl+Enter too", () => {
    expect(composerKeyAction(key({ metaKey: true }), true)).toBe("send");
    expect(composerKeyAction(key({ ctrlKey: true }), true)).toBe("send");
  });
});

describe("composerKeyAction with enter_to_submit off", () => {
  it("adds a line on Enter and on Shift+Enter (negative)", () => {
    expect(composerKeyAction(key(), false)).toBe("newline");
    expect(composerKeyAction(key({ shiftKey: true }), false)).toBe("newline");
  });

  it("sends on Cmd+Enter", () => {
    expect(composerKeyAction(key({ metaKey: true }), false)).toBe("send");
  });

  it("sends on Ctrl+Enter", () => {
    expect(composerKeyAction(key({ ctrlKey: true }), false)).toBe("send");
  });
});

describe("composerKeyAction during IME composition", () => {
  // Japanese and Chinese input commit a word with Enter. Chrome and Firefox
  // mark that keydown `isComposing`.
  it.each([true, false])(
    "leaves an Enter marked isComposing to the editor (enter_to_submit %s, negative)",
    (enterToSubmit) => {
      const plain = key(COMPOSING);
      const chord = key({ ...COMPOSING, metaKey: true });
      expect(composerKeyAction(plain, enterToSubmit)).toBe("ignore");
      expect(composerKeyAction(chord, enterToSubmit)).toBe("ignore");
    },
  );

  // Safari fires the committing keydown after composition has ended, marked
  // only with keyCode 229.
  it.each([true, false])(
    "leaves an Enter with keyCode 229 to the editor (enter_to_submit %s, negative)",
    (enterToSubmit) => {
      const plain = key({ keyCode: 229 });
      const chord = key({ keyCode: 229, ctrlKey: true });
      expect(composerKeyAction(plain, enterToSubmit)).toBe("ignore");
      expect(composerKeyAction(chord, enterToSubmit)).toBe("ignore");
    },
  );
});

describe("composerKeyAction on other keys", () => {
  it.each([true, false])(
    "ignores a key that is not Enter (enter_to_submit %s, negative)",
    (enterToSubmit) => {
      const letter = key({ key: "a", keyCode: 65 });
      const chord = key({ key: "Escape", keyCode: 27, metaKey: true });
      expect(composerKeyAction(letter, enterToSubmit)).toBe("ignore");
      expect(composerKeyAction(chord, enterToSubmit)).toBe("ignore");
    },
  );
});
