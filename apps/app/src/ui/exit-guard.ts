"use client";
// Holding the window while a value exists only on this screen.
//
// A dialog's close paths are its own `onOpenChange`, and a modal dialog's
// backdrop makes the page behind it inert, so the links there cannot be
// clicked while it is open (`@base-ui/react` renders one whenever `modal` is
// set, which is its default). None of that reaches the browser: a refresh, a
// tab closing, a typed address or the Back button unmounts the island whatever
// is on screen. A value the server hands back exactly once lives in client
// state and nowhere else, so each of those exits loses it.
//
// Two listeners cover what a dialog cannot:
//
//   - `beforeunload` puts the browser's own "leave site?" prompt in front of a
//     refresh, a tab close and an address-bar navigation.
//   - Back is a same-document history navigation, so `beforeunload` never
//     fires for it. A sentinel entry pushed when the guard arms gives that Back
//     something to consume; the `popstate` it produces pushes the sentinel
//     again and tells the caller, which says why on the screen the person is
//     already looking at.
//
// The alternative — writing the value to `localStorage` so it survives a
// reload — is worse than the defect: a secret shown once would then sit in
// browser storage indefinitely, readable by anything with the origin. The
// value stays in memory and the window is held instead.
//
// The guard arms only while something can actually be lost. A prompt that
// fires when there is nothing to lose is one people learn to click through,
// and then it no longer works the one time it matters.
import { useEffect, useRef } from "react";

/**
 * Hold the window while `atRisk`.
 *
 * `onBlocked` is called when a Back press was turned back, so the caller can
 * say why; it is read through a ref, so a caller may pass a fresh closure on
 * every render without re-arming the guard.
 *
 * Arming pushes one history entry. It is not popped on disarm: the same write
 * that ends the risk usually navigates, and `router.replace` overwrites the
 * sentinel, which is the current entry — so the common path leaves nothing
 * behind. Where a write is refused and the person stays, one duplicate entry
 * survives and a later Back re-renders this route once before leaving it.
 * Popping it instead would mean calling `history.back()` from a cleanup that
 * also runs when a real navigation unmounted the caller, which would undo that
 * navigation. One spare entry is the cheaper mistake.
 */
export function useExitGuard(atRisk: boolean, onBlocked: () => void): void {
  const blocked = useRef(onBlocked);
  useEffect(() => {
    blocked.current = onBlocked;
  });

  useEffect(() => {
    if (!atRisk) return;

    const hold = (event: BeforeUnloadEvent) => {
      // The browser chooses the wording and ignores anything we pass; asking
      // is the whole of it.
      event.preventDefault();
    };
    const turnBack = () => {
      // Same URL, so Next's patched `pushState` copies its internal history
      // state onto the entry and dispatches no router action: the route does
      // not change and this island keeps its state.
      window.history.pushState(null, "");
      blocked.current();
    };

    window.history.pushState(null, "");
    window.addEventListener("beforeunload", hold);
    window.addEventListener("popstate", turnBack);
    return () => {
      window.removeEventListener("beforeunload", hold);
      window.removeEventListener("popstate", turnBack);
    };
  }, [atRisk]);
}
