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

/**
 * What one tab tells the others, and deliberately no more than that.
 *
 * Two tabs of the same account are two JavaScript realms, so each has its own
 * copy of everything above: `begin()` answered true in both, both rotated, and
 * the second commit voided the first tab's set while that tab still showed it
 * under "New recovery codes" with a button that says they are saved. Somebody
 * writes down codes that already do not work.
 *
 * The signal carries a person's id and nothing else. It never carries the
 * codes: putting a second-factor bypass on a channel any script in the origin
 * can open would trade this defect for a worse one, and the same reasoning
 * keeps the set out of `localStorage` above.
 *
 * What this is not: a lock. `BroadcastChannel` delivers asynchronously, so two
 * presses in the same instant can still both start. It narrows the window and,
 * more importantly, makes the loser's set say so instead of lying: a tab told
 * that another has rotated drops its now-void set and shows the same
 * "may already have changed" state a lost answer produces. Real serialization
 * belongs at the server, which is the only place that knows which write won.
 */
type VaultSignal = {
  /**
   * `rotating` opens the window and `finished` closes it, whatever the answer
   * was: without the second, a tab whose rotation was refused would leave every
   * other tab blocked for the life of the page. `rotated` is the narrower
   * claim that a set was actually issued, which is the only one that voids
   * what another tab is showing.
   */
  kind: "rotating" | "finished" | "rotated";
  userId: string;
};

const CHANNEL = "oxagen.recovery-codes";

/** A rotation another tab announced and has not finished. */
let elsewhere: string | null = null;

function onSignal(signal: VaultSignal): void {
  if (signal.kind === "rotating") {
    elsewhere = signal.userId;
    return;
  }
  elsewhere = null;
  if (signal.kind === "finished") return;
  if (state.userId !== signal.userId) return;
  // Another tab completed a rotation for this person. Whatever this tab holds
  // was issued before that write, so it is void; and this tab cannot know
  // whether the other one's set was saved, so the honest state is the doubtful
  // one rather than an empty panel.
  if (state.codes !== null || state.uncertain) {
    set({
      userId: state.userId,
      rotating: state.rotating,
      codes: null,
      uncertain: true,
    });
  }
}

let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
  if (channel !== null) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<VaultSignal>) => {
      onSignal(event.data);
    };
    return channel;
  } catch {
    // No channel in this environment. The in-page guards still hold; only the
    // cross-tab half is unavailable, which is where this started.
    return null;
  }
}

function announce(signal: VaultSignal): void {
  try {
    bus()?.postMessage(signal);
  } catch {
    // A closed or unavailable channel must not fail a rotation.
  }
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
    // Another tab of this account has a rotation out. Its answer will void
    // whatever this one would get, so starting a second is how both tabs end
    // up showing a set and only one of them being real.
    if (elsewhere !== null) return false;
    announce({ kind: "rotating", userId });
    set({
      userId,
      rotating: true,
      codes: mine ? state.codes : null,
      uncertain: mine && state.uncertain,
    });
    return true;
  },
  /** Whether another tab's rotation is what `begin` refused on. */
  rotatingElsewhere(): boolean {
    return elsewhere !== null;
  },
  /**
   * Whether the refusal above is what would stop a rotation for this person:
   * somebody else's set is unsaved, or their rotation never resolved.
   */
  heldByAnother(userId: string): boolean {
    return state.userId !== null && state.userId !== userId && atStake(state);
  },
  /** The rotation answered: nothing is on the wire any more. */
  end(): void {
    // Whatever it answered, this tab's rotation is no longer out, so the other
    // tabs stop refusing on it. Whether a set was issued is `hold`'s to say.
    if (state.userId !== null)
      announce({ kind: "finished", userId: state.userId });
    if (state.rotating) set({ ...state, rotating: false });
  },
  /** The rotation answered with a set: hold it until it is saved. */
  hold(userId: string, codes: string[]): void {
    // The one signal that matters to another tab: a set it is showing was
    // issued before this write, so it is void now. The codes stay here.
    announce({ kind: "rotated", userId });
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
    elsewhere = null;
    set(EMPTY);
  },
  /**
   * Test seam for the cross-tab signal, since a second realm cannot be opened
   * in a unit test. Delivers what another tab would have posted.
   */
  receiveForTests(signal: VaultSignal): void {
    onSignal(signal);
  },
};
