// @vitest-environment jsdom
// LiveRefresh re-renders the server page on an interval while a page waits on
// work outside the browser (a merge on the host, a repository sync). The
// cases that matter are the ones where it must stay quiet: a poll that keeps
// going after the wait is over, in a hidden tab, or after the page left, is a
// server render every few seconds that nobody sees.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { navigate } = vi.hoisted(() => ({
  navigate: {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    advance: vi.fn(),
  },
}));
vi.mock("@/ui/navigation", () => ({ useNavigate: () => navigate }));

// The test owns the transition's pending flag, so a case can hold a refresh
// "still rendering" the way a slow server page does.
const { transition } = vi.hoisted(() => ({ transition: { pending: false } }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useTransition: () =>
      [
        transition.pending,
        (fn: () => void) => {
          fn();
        },
      ] as const,
  };
});

const { LiveRefresh } = await import("./live-refresh");

// jsdom's own visibility answer depends on how the environment was built, so
// the test owns it. That also lets a case hide the tab.
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers();
  transition.pending = false;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Drop the own property so the prototype's getter answers again.
  Reflect.deleteProperty(document, "visibilityState");
});

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("LiveRefresh", () => {
  it("refreshes once per interval while active and the tab is visible", () => {
    render(<LiveRefresh active intervalMs={1_000} />);
    expect(navigate.refresh).not.toHaveBeenCalled();
    advance(3_000);
    expect(navigate.refresh).toHaveBeenCalledTimes(3);
  });

  it("waits five seconds between refreshes when no interval is given", () => {
    // The freshness panel relies on the default. A shorter one would put a
    // server render on every open Steering page far more often than a sync
    // can finish.
    render(<LiveRefresh active />);
    advance(4_999);
    expect(navigate.refresh).not.toHaveBeenCalled();
    advance(1);
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing while inactive", () => {
    render(<LiveRefresh active={false} intervalMs={1_000} />);
    advance(10_000);
    expect(navigate.refresh).not.toHaveBeenCalled();
  });

  it("skips the ticks while the tab is hidden and resumes when it is shown", () => {
    render(<LiveRefresh active intervalMs={1_000} />);
    visibility = "hidden";
    advance(5_000);
    expect(navigate.refresh).not.toHaveBeenCalled();
    visibility = "visible";
    advance(1_000);
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
  });

  it("stops when the page it rendered has nothing left to wait for", () => {
    // The refreshed page renders LiveRefresh again with `active` false once
    // the sync is done. The interval must end there, not run until unmount.
    const { rerender } = render(<LiveRefresh active intervalMs={1_000} />);
    advance(1_000);
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
    rerender(<LiveRefresh active={false} intervalMs={1_000} />);
    advance(5_000);
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while the last refresh is still rendering (negative)", () => {
    // The router queues refreshes and server actions one at a time. A refresh
    // sent over one still rendering would pile up behind it, and an action
    // the page sends would wait behind both.
    const { rerender } = render(<LiveRefresh active intervalMs={1_000} />);
    advance(1_000);
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
    transition.pending = true;
    rerender(<LiveRefresh active intervalMs={1_000} />);
    advance(3_000);
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
    transition.pending = false;
    rerender(<LiveRefresh active intervalMs={1_000} />);
    advance(1_000);
    expect(navigate.refresh).toHaveBeenCalledTimes(2);
  });

  it("stops after it unmounts", () => {
    const { unmount } = render(<LiveRefresh active intervalMs={1_000} />);
    advance(2_000);
    expect(navigate.refresh).toHaveBeenCalledTimes(2);
    unmount();
    advance(10_000);
    expect(navigate.refresh).toHaveBeenCalledTimes(2);
  });
});
