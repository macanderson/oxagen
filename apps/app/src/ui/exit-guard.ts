"use client";
// Holding the window while a value exists only on this screen.
//
// A dialog's close paths are its own `onOpenChange`, and a modal dialog's
// backdrop makes the page behind it inert, so the links there cannot be
// clicked while it is open (`@base-ui/react` renders one whenever `modal` is
// set, which is its default). Neither reaches the browser: a refresh, a tab
// closing or a typed address unmounts the island whatever is on screen, and a
// value the server hands back exactly once lives in client state and nowhere
// else, so each of those exits loses it. `beforeunload` puts the browser's own
// "leave site?" prompt in front of all three.
//
// The alternative — writing the value to `localStorage` so it survives a
// reload — is worse than the defect: a secret shown once would then sit in
// browser storage indefinitely, readable by anything with the origin. The
// value stays in memory and the window is held instead.
//
// The guard arms only while something can actually be lost. A prompt that
// fires when there is nothing to lose is one people learn to click through,
// and then it no longer works the one time it matters.
//
// **Back is not held, deliberately.** It is a same-document history
// navigation, so no `beforeunload` runs, and `popstate` fires only after the
// traverse has been committed — too late to render anything. The one way to
// pre-empt it is to push a duplicate history entry for Back to consume, and
// that entry cannot be reclaimed cleanly: the write that ends the risk
// finishes with `router.replace` onto the page it is already on, which
// overwrites the duplicate but leaves the identical entry beneath it, so every
// completed write would add a Back press that appears to do nothing. Taking it
// back with `history.back()` from the effect's cleanup instead races that same
// `router.replace` and can leave the roster showing the pre-write tree. A dead
// Back stop on every successful write is a certain cost against an uncertain
// one, and Back is a deliberate act where a refresh is usually a slip.
import { useEffect } from "react";

/**
 * Ask the browser to confirm before it unloads the page, while `atRisk`.
 *
 * Covers refresh, tab or window close, and an address typed over the current
 * one. It does not cover Back, and no in-page code can — see above.
 */
export function useExitGuard(atRisk: boolean): void {
  useEffect(() => {
    if (!atRisk) return;
    const hold = (event: BeforeUnloadEvent) => {
      // The browser chooses the wording and ignores anything we pass; asking
      // is the whole of it.
      event.preventDefault();
    };
    window.addEventListener("beforeunload", hold);
    return () => {
      window.removeEventListener("beforeunload", hold);
    };
  }, [atRisk]);
}
