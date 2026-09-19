// Where a freshly issued set of recovery codes lives until the person saves it.
//
// Better Auth voids the old codes the moment a rotation lands on the server,
// and it keeps only hashes of the new ones. So from that moment until the
// person says the set is saved, this page holds the only copy that will ever
// exist. Losing it is a locked-out account on the next lost authenticator.
//
// The copy used to live in the Account dialog's state. The dialog is part of
// the shell, and the shell is mounted per organization, so every client-side
// transition that leaves the organization unmounted it and the codes with it:
// a link into another organization, sign out, and the browser's Back and
// Forward buttons. None of those unloads the page, so `beforeunload` never
// runs for them, and Back cannot be intercepted before Next.js commits it
// (`src/ui/exit-guard.ts` explains why). Guarding each exit in turn leaves the
// next one open.
//
// So the set is held at the page's own lifetime instead: in this module, which
// lives as long as the JavaScript realm does. A client-side transition does not
// end the realm, so no transition of any kind can drop the set. Only a reload
// or a closed tab can, and those are the exits the browser's own prompt covers,
// which this module arms while anything is at stake.
//
// It is memory only, never storage. Writing the set to `localStorage` or to the
// server would outlive the page, and a second-factor bypass sitting at rest is
// a worse failure than one more rotation. The set is keyed to the person it was
// issued to, so if a different person ever signs in within the same page, they
// are never shown it.

import { useSyncExternalStore } from "react";

type VaultState = {
  /** The person whose rotation this is, while anything is held. */
  userId: string | null;
  /** A rotation is on the wire: the old set may already be void. */
  rotating: boolean;
  /** The set Better Auth returned, not yet acknowledged as saved. */
  codes: string[] | null;
};

const EMPTY: VaultState = { userId: null, rotating: false, codes: null };

let state: VaultState = EMPTY;
const listeners = new Set<() => void>();

function atStake(s: VaultState): boolean {
  return s.rotating || s.codes !== null;
}

// The browser's own "leave site?" prompt, armed while anything is at stake.
// `preventDefault` is the specified opt-in; the wording is the browser's.
function ask(event: BeforeUnloadEvent): void {
  event.preventDefault();
}
let asking = false;

function set(next: VaultState): void {
  state = next;
  const shouldAsk = atStake(next);
  if (typeof window !== "undefined" && shouldAsk !== asking) {
    if (shouldAsk) window.addEventListener("beforeunload", ask);
    else window.removeEventListener("beforeunload", ask);
    asking = shouldAsk;
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What `userId` has at stake: nothing of anyone else's is ever returned. */
export type HeldCodes = { rotating: boolean; codes: string[] | null };

const NOTHING: HeldCodes = { rotating: false, codes: null };

function view(s: VaultState, userId: string): HeldCodes {
  if (s.userId !== userId) return NOTHING;
  return s;
}

export function useRecoveryCodeVault(userId: string): HeldCodes {
  return useSyncExternalStore(
    subscribe,
    () => view(state, userId),
    () => NOTHING,
  );
}

export const recoveryCodeVault = {
  /**
   * Claim the one rotation that may run. False when one is already on the
   * wire: two rotations can settle in either order, and the loser's set would
   * land after the winner's, on screen and already void.
   */
  begin(userId: string): boolean {
    if (state.rotating) return false;
    set({
      userId,
      rotating: true,
      codes: state.userId === userId ? state.codes : null,
    });
    return true;
  },
  /** The rotation answered: nothing is on the wire any more. */
  end(): void {
    if (state.rotating) set({ ...state, rotating: false });
  },
  /** The rotation answered with a set: hold it until it is saved. */
  hold(userId: string, codes: string[]): void {
    set({ userId, rotating: false, codes });
  },
  /**
   * The rotation failed, or the person saved the set. Either way nothing is
   * held: a failed rotation leaves the stored set unknowable from here, so no
   * set may be shown as if it were the one stored.
   */
  clear(): void {
    set(EMPTY);
  },
};

/** Test seam: the module outlives each test's render, as it outlives a page's transitions. */
export function resetRecoveryCodeVaultForTests(): void {
  set(EMPTY);
}
