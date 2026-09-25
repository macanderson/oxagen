// What a key pressed in the assistant composer does, under the person's
// `enter_to_submit` preference (ADR-075, `get_user_preferences`).
//
// - On, Enter sends and Shift+Enter adds a line.
// - Off, the stored default, Enter adds a line and Cmd+Enter or Ctrl+Enter
//   sends.
//
// An Enter pressed while an input method editor is composing belongs to the
// editor. Japanese and Chinese input commit a word with Enter, so reading that
// key as a send would post the question mid-word. Chrome and Firefox mark the
// key with `isComposing`. Safari fires the committing keydown after composition
// has ended and marks it only with keyCode 229, so both are checked.
//
// The decision is only about the key. Whether a send may go ahead (an empty
// draft, a turn already in flight, a draft over the limit) stays with the
// flyout's submit path, the same one the Send button takes.

/**
 * What the composer does with a key.
 *
 * - `send` submits the composer's form, and the key adds no line.
 * - `newline` leaves Enter to the browser, which adds a line.
 * - `ignore` is any other key, or an Enter the input method editor owns.
 */
export type ComposerKeyAction = "send" | "newline" | "ignore";

/**
 * The parts of a keydown the decision reads. React's `KeyboardEvent` has this
 * shape, so the composer passes its event as it is.
 */
export type ComposerKeyEvent = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** Deprecated in the DOM, and still the only IME signal Safari gives. */
  keyCode: number;
  nativeEvent: { isComposing: boolean };
};

/** The keyCode a browser reports for a key the input method editor handled. */
const IME_KEY_CODE = 229;

/** What `event` does in the composer when `enter_to_submit` is `enterToSubmit`. */
export function composerKeyAction(
  event: ComposerKeyEvent,
  enterToSubmit: boolean,
): ComposerKeyAction {
  if (event.nativeEvent.isComposing || event.keyCode === IME_KEY_CODE)
    return "ignore";
  if (event.key !== "Enter") return "ignore";
  if (enterToSubmit) return event.shiftKey ? "newline" : "send";
  return event.metaKey || event.ctrlKey ? "send" : "newline";
}
