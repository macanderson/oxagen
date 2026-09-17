// @vitest-environment jsdom
// The guard around a value that exists only on one screen. The case it is for
// is the one a dialog cannot see: the person refreshes, closes the tab or
// types an address while a write is in flight, and the answer — a secret the
// server hands back exactly once — arrives with nobody to hand it to. The
// dialog's own close paths are held elsewhere (`openChange`); this holds the
// browser's unload.
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExitGuard } from "./exit-guard";

/** Dispatches the event a refresh, a tab close or a typed address produces. */
function tryToLeave(): boolean {
  return !window.dispatchEvent(
    new Event("beforeunload", { cancelable: true, bubbles: false }),
  );
}

let pushState: ReturnType<typeof vi.spyOn>;
let back: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pushState = vi.spyOn(window.history, "pushState");
  back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
});
afterEach(() => {
  // No auto-cleanup is configured in this suite, and a hook left mounted keeps
  // its window listener: the next test would then measure this one's guard.
  cleanup();
  vi.restoreAllMocks();
});

describe("useExitGuard", () => {
  it("holds a refresh, a tab close and an address-bar navigation while at risk", () => {
    renderHook(() => {
      useExitGuard(true);
    });
    expect(tryToLeave()).toBe(true);
  });

  it("lets the window go when nothing is at risk, so the prompt keeps its meaning (negative)", () => {
    // A prompt that fires when there is nothing to lose is one people learn to
    // click through, and then it does not work the once it matters.
    renderHook(() => {
      useExitGuard(false);
    });
    expect(tryToLeave()).toBe(false);
  });

  it("stops holding the window once the risk is over", () => {
    const { rerender } = renderHook(
      ({ atRisk }: { atRisk: boolean }) => {
        useExitGuard(atRisk);
      },
      { initialProps: { atRisk: true } },
    );
    expect(tryToLeave()).toBe(true);
    rerender({ atRisk: false });
    expect(tryToLeave()).toBe(false);
  });

  it("drops the listener when the caller unmounts", () => {
    const { unmount } = renderHook(() => {
      useExitGuard(true);
    });
    unmount();
    expect(tryToLeave()).toBe(false);
  });

  it("holds the window until the last of several guards is done", () => {
    // Every key write on the page mounts its own dialog and its own guard. The
    // hook keeps no state outside its own effect, so two armed at once are two
    // listeners, each asking; the window is free only when neither asks.
    const first = renderHook(() => {
      useExitGuard(true);
    });
    const second = renderHook(() => {
      useExitGuard(true);
    });
    expect(tryToLeave()).toBe(true);
    first.unmount();
    expect(tryToLeave()).toBe(true);
    second.unmount();
    expect(tryToLeave()).toBe(false);
    expect(pushState).not.toHaveBeenCalled();
  });

  it("touches the history stack neither on arming nor on release (negative)", () => {
    // An earlier form of this guard pushed a duplicate entry for Back to
    // consume. `router.replace` onto the page it is already on overwrote that
    // duplicate but left the identical entry beneath it, so every completed
    // write added a Back press that went nowhere — and reclaiming it from the
    // cleanup raced that same `replace`. The guard now leaves history alone.
    const { rerender, unmount } = renderHook(
      ({ atRisk }: { atRisk: boolean }) => {
        useExitGuard(atRisk);
      },
      { initialProps: { atRisk: true } },
    );
    rerender({ atRisk: false });
    rerender({ atRisk: true });
    unmount();
    expect(pushState).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });
});
