// @vitest-environment jsdom
// The one slot the workspace layer publishes its reads into and the chrome
// reads from: keyed by the workspace slug so a chrome never draws another
// workspace's figures, and withdrawn when the workspace layer leaves, but only
// if what it withdraws is still its own.
import { act, cleanup, render, renderHook } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import {
  useWorkspaceActivity,
  type WorkspaceActivity,
  WorkspaceActivitySync,
} from "./activity-store";

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function activity(slug: string, unread: number): WorkspaceActivity {
  return {
    slug,
    counts: readOk({ approvals: 0, proposals: unread, incidents: 0 }),
    feed: readOk({ items: [], unread }),
  };
}

describe("useWorkspaceActivity", () => {
  it("is null until a workspace publishes", () => {
    const { result } = renderHook(() => useWorkspaceActivity("core-platform"));
    expect(result.current).toBeNull();
  });

  it("answers what the workspace in the URL published", () => {
    const core = activity("core-platform", 3);
    const { result } = renderHook(() => useWorkspaceActivity("core-platform"));
    act(() => {
      render(<WorkspaceActivitySync activity={core} />);
    });
    expect(result.current).toBe(core);
  });

  it("answers null for another workspace's figures, and outside a workspace (negative)", () => {
    const { result: other } = renderHook(() => useWorkspaceActivity("finops"));
    const { result: none } = renderHook(() => useWorkspaceActivity(null));
    act(() => {
      render(<WorkspaceActivitySync activity={activity("core-platform", 3)} />);
    });
    expect(other.current).toBeNull();
    expect(none.current).toBeNull();
  });
});

describe("WorkspaceActivitySync", () => {
  it("withdraws what it published when the workspace layer unmounts", () => {
    const { result } = renderHook(() => useWorkspaceActivity("core-platform"));
    let unmount = () => {};
    act(() => {
      ({ unmount } = render(
        <WorkspaceActivitySync activity={activity("core-platform", 3)} />,
      ));
    });
    expect(result.current).not.toBeNull();
    act(() => {
      unmount();
    });
    expect(result.current).toBeNull();
  });

  it("replaces the slot when the layer re-reads, and the old read's cleanup leaves the new one standing", () => {
    const first = activity("core-platform", 3);
    const second = activity("core-platform", 5);
    const { result } = renderHook(() => useWorkspaceActivity("core-platform"));
    let rerender: (ui: ReactElement) => void = () => {};
    act(() => {
      ({ rerender } = render(<WorkspaceActivitySync activity={first} />));
    });
    act(() => {
      rerender(<WorkspaceActivitySync activity={second} />);
    });
    expect(result.current).toBe(second);
  });

  it("does not withdraw a newer workspace's read when an older layer unmounts after it published (negative)", () => {
    const core = activity("core-platform", 3);
    const finops = activity("finops", 7);
    const { result } = renderHook(() => useWorkspaceActivity("finops"));
    let unmountCore = () => {};
    act(() => {
      ({ unmount: unmountCore } = render(
        <WorkspaceActivitySync activity={core} />,
      ));
    });
    act(() => {
      render(<WorkspaceActivitySync activity={finops} />);
    });
    act(() => {
      unmountCore();
    });
    expect(result.current).toBe(finops);
  });
});
