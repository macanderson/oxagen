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
  /**
   * A rotation left and its answer never came back. The server may have
   * committed it, in which case the old set is void and the new one is gone,
   * or it may not. Nothing on this page can tell which, so only a rotation
   * that does answer with a set ends this.
   */
  uncertain: boolean;
};

const EMPTY: VaultState = {
  userId: null,
  rotating: false,
  codes: null,
  uncertain: false,
};

let state: VaultState = EMPTY;
const listeners = new Set<() => void>();

function atStake(s: VaultState): boolean {
  return s.rotating || s.codes !== null || s.uncertain;
}

// The browser's own "leave site?" prompt, armed while anything is at stake.
// `preventDefault` is the specified opt-in; the wording is the browser's.
function ask(event: BeforeUnloadEvent): void {
  event.preventDefault();
}
let asking = false;

// The cross-tab claim. This store is one per tab, and each tab is its own
// JavaScript realm, so the in-page gate in `begin()` cannot see a rotation in
// another tab. Two tabs rotating for one account is the same failure as two
// rotations in one: the later server commit voids the earlier set while the
// earlier tab still shows it as the one to save.
//
// A Web Lock is shared by every tab of the origin and is dropped by the
// browser when the tab holding it closes or crashes, so a tab that dies
// mid-rotation cannot wedge the others. It is held from the start of a
// rotation until nothing is at stake here: through an unsaved set and through
// a lost answer, not only while the request is on the wire, because a second
// tab rotating after the first one's answer arrives voids that answer just
// the same. The lock carries no codes. Nothing leaves this tab's memory.
const ROTATION_LOCK = "oxagen.recovery-code-rotation";
let releaseLock: (() => void) | null = null;

function set(next: VaultState): void {
  state = next;
  const shouldAsk = atStake(next);
  if (typeof window !== "undefined" && shouldAsk !== asking) {
    if (shouldAsk) window.addEventListener("beforeunload", ask);
    else window.removeEventListener("beforeunload", ask);
    asking = shouldAsk;
  }
  if (!shouldAsk && releaseLock) {
    releaseLock();
    releaseLock = null;
  }
  for (const listener of listeners) listener();
}

/**
 * Take the cross-tab rotation lock, or keep the one this tab already holds.
 * False when another tab holds it. A browser without Web Locks gets the
 * in-page gate alone, which is what every tab had before.
 */
function claimAcrossTabs(): Promise<boolean> {
  if (releaseLock) return Promise.resolve(true);
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    locks
      .request(ROTATION_LOCK, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        // Held until `set()` sees nothing at stake and calls this.
        return new Promise<void>((release) => {
          releaseLock = release;
          resolve(true);
        });
      })
      // A lock manager that fails is treated as one that is absent, so the
      // in-page gate still stands and the person is not locked out.
      .catch(() => {
        resolve(true);
      });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What `userId` has at stake: nothing of anyone else's is ever returned. */
export type HeldCodes = {
  rotating: boolean;
  codes: string[] | null;
  uncertain: boolean;
};

const NOTHING: HeldCodes = { rotating: false, codes: null, uncertain: false };

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
   *
   * False too while someone else has anything at stake. If a person's session
   * ends elsewhere and another signs in within the same page, the first
   * person's unsaved set or unresolved rotation is still here, hidden from the
   * second. Letting the second rotate would overwrite it, and that set is the
   * only copy there is. Nothing is lost by refusing: a reload clears the page
   * after the browser has asked.
   */
  begin(userId: string): boolean {
    if (state.rotating) return false;
    const mine = state.userId === userId;
    // Never over the top of someone else's unsaved set or unresolved doubt.
    //
    // This store outlives every client transition, which is the point of it,
    // and that includes a sign-out and a sign-in as somebody else in the same
    // tab. `view()` hides one person's state from another, so the second
    // person sees an empty panel and has no way to know anything is held. A
    // rotation from there used to overwrite `codes` and `uncertain` with the
    // new owner's blank state, destroying the first person's only plaintext
    // copy of a set the server had already swapped in. They were signed out,
    // so they could not save it first and cannot get it back.
    //
    // Refusing costs the second person a rotation they can have after a
    // reload, which drops this store with the page. Allowing it costs the
    // first person their account on the next lost authenticator. The tab
    // reads `heldByAnother` and says which of the two happened, rather than
    // leaving a button that does nothing.
    if (!mine && atStake(state)) return false;
    set({
      userId,
      rotating: true,
      codes: mine ? state.codes : null,
      uncertain: mine && state.uncertain,
    });
    return true;
  },
  /**
   * Whether the refusal above is what would stop a rotation for this person:
   * somebody else's set is unsaved, or their rotation never resolved.
   */
  heldByAnother(userId: string): boolean {
    return state.userId !== null && state.userId !== userId && atStake(state);
  },
  /**
   * The second half of `begin()`: claim the rotation across every tab of this
   * browser. False when another tab has a rotation running or codes unsaved;
   * the caller then calls `end()` and says so. Awaited before the request
   * leaves, so a refused claim sends nothing.
   */
  claimAcrossTabs,
  /** The rotation answered: nothing is on the wire any more. */
  end(): void {
    if (state.rotating) set({ ...state, rotating: false });
  },
  /** The rotation answered with a set: hold it until it is saved. */
  hold(userId: string, codes: string[]): void {
    set({ userId, rotating: false, codes, uncertain: false });
  },
  /**
   * The server answered and refused, a wrong password for one. It answered,
   * so this rotation changed nothing. Any doubt left by an earlier lost answer
   * still stands: a refusal now says nothing about that one.
   */
  refuse(): void {
    // A set still waiting to be saved is untouched as well: a refused rotation
    // did not replace it, so it is still the one that works.
    set(
      state.uncertain || state.codes !== null
        ? { ...state, rotating: false }
        : EMPTY,
    );
  },
  /**
   * The call threw: the request may or may not have reached the server, and
   * the answer is lost either way. The old set may already be void, so the
   * page stays guarded until a rotation answers with a set.
   */
  lose(userId: string): void {
    set({ userId, rotating: false, codes: null, uncertain: true });
  },
  /** The person saved the set: the single showing was received. */
  clear(): void {
    set(EMPTY);
  },
  /**
   * Test seam: the module outlives each test's render, as it outlives a page's
   * transitions, so a case that leaves something at stake would otherwise leak
   * into the next one.
   *
   * A method on this object rather than its own export, because
   * `knip --production --strict` reads a test-only export as dead code: the
   * production pass does not look at test files, so nothing appears to call
   * it. The baseline in `knip-baseline.json` is shrink-only by design, so
   * listing it there would be the wrong direction. This object is already
   * reached from production code, so hanging the seam on it adds no surface
   * knip has to be told to ignore.
   */
  resetForTests(): void {
    set(EMPTY);
  },
};
