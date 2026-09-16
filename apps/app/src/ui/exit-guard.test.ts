// @vitest-environment jsdom
// The guard around a value that exists only on one screen. The case it is for
// is the one a dialog cannot see: the person refreshes, closes the tab, types
// an address or presses Back while a write is in flight, and the answer — a
// secret the server hands back exactly once — arrives with nobody to hand it
// to. The dialog's own close paths are held elsewhere (`openChange`); these
// are the browser's.
import { cleanup, act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useExitGuard } from "./exit-guard";

/** Dispatches the event a refresh, a tab close or a typed address produces. */
function tryToLeave(): boolean {
  return !window.dispatchEvent(
    new Event("beforeunload", { cancelable: true, bubbles: false }),
  );
}

/** Dispatches the event a Back press produces. */
function pressBack(): void {
  window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
}

let pushState: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pushState = vi.spyOn(window.history, "pushState");
});
afterEach(() => {
  // No auto-cleanup is configured in this suite, and a hook left mounted keeps
  // its window listeners: the next test would then measure this one's guard.
  cleanup();
  vi.restoreAllMocks();
});

describe("useExitGuard", () => {
  it("holds a refresh, a tab close and an address-bar navigation while at risk", () => {
    renderHook(() => {
      useExitGuard(true, () => undefined);
    });
    expect(tryToLeave()).toBe(true);
  });

  it("lets the window go when nothing is at risk, so the prompt keeps its meaning (negative)", () => {
    // A prompt that fires when there is nothing to lose is one people learn to
    // click through, and then it does not work the once it matters.
    renderHook(() => {
      useExitGuard(false, () => undefined);
    });
    expect(tryToLeave()).toBe(false);
    expect(pushState).not.toHaveBeenCalled();
  });

  it("turns a Back press back and says so, because beforeunload never fires for one", () => {
    // Back is a same-document history navigation: the browser runs no unload
    // and asks nothing. The sentinel pushed on arming is what that Back
    // consumes, and this pushes another in its place.
    const onBlocked = vi.fn();
    renderHook(() => {
      useExitGuard(true, onBlocked);
    });
    expect(pushState).toHaveBeenCalledTimes(1);

    act(() => {
      pressBack();
    });
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(pushState).toHaveBeenCalledTimes(2);
    // Same URL: Next copies its internal history state onto the entry and
    // dispatches no router action, so the route and this island's state stay.
    expect(pushState).toHaveBeenLastCalledWith(null, "");
  });

  it("ignores a Back press once nothing is at risk (negative)", () => {
    const onBlocked = vi.fn();
    const { rerender } = renderHook(
      ({ atRisk }: { atRisk: boolean }) => {
        useExitGuard(atRisk, onBlocked);
      },
      { initialProps: { atRisk: true } },
    );
    rerender({ atRisk: false });

    act(() => {
      pressBack();
    });
    expect(onBlocked).not.toHaveBeenCalled();
    expect(tryToLeave()).toBe(false);
  });

  it("re-arms nothing when only the callback changes, and calls the newest one", () => {
    // The caller passes a fresh closure every render. Re-arming on each would
    // push a history entry per keystroke.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onBlocked }: { onBlocked: () => void }) => {
        useExitGuard(true, onBlocked);
      },
      { initialProps: { onBlocked: first } },
    );
    rerender({ onBlocked: second });
    expect(pushState).toHaveBeenCalledTimes(1);

    act(() => {
      pressBack();
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("drops both listeners when the caller unmounts", () => {
    const onBlocked = vi.fn();
    const { unmount } = renderHook(() => {
      useExitGuard(true, onBlocked);
    });
    unmount();

    expect(tryToLeave()).toBe(false);
    act(() => {
      pressBack();
    });
    expect(onBlocked).not.toHaveBeenCalled();
  });
});
