// @vitest-environment jsdom
// Reading the page again when the stream says a run's stale light changed.
//
// The Run page read a run as stale or live once, when it rendered, so a page
// left open kept pulsing live after the host went quiet (A-02, #4343 review).
// These prove the page is read again when the stream's row disagrees with it,
// or a frame lands while it reads stale, and only once per new reading.
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigate } = vi.hoisted(() => ({
  navigate: {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    advance: vi.fn(),
  },
}));
vi.mock("@/ui/navigation", () => ({ useNavigate: () => navigate }));

const { useStaleRefresh } = await import("./use-stale-refresh");

const QUIET = { status: "live", commandBlock: "host_offline" } as const;
const REVOKED = { status: "live", commandBlock: "host_revoked" } as const;
const POLLING = { status: "live", commandBlock: null } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useStaleRefresh", () => {
  it("reads the page again once when the stream's row says the host went quiet", () => {
    const { result } = renderHook(() => useStaleRefresh(false));
    result.current.onRun(QUIET);
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
    // The same reading again, before the page's read lands, asks nothing more.
    result.current.onRun(QUIET);
    result.current.onRun(REVOKED);
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
  });

  it("reads the page again when a frame lands on a page that reads stale, since the host is back", () => {
    const { result } = renderHook(() => useStaleRefresh(true));
    result.current.onFrames();
    result.current.onFrames();
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
  });

  it("reads the page again when the stream's row says the host is back", () => {
    const { result } = renderHook(() => useStaleRefresh(true));
    result.current.onRun(POLLING);
    expect(navigate.refresh).toHaveBeenCalledTimes(1);
  });

  it("reads nothing when the stream agrees with the page (negative)", () => {
    const live = renderHook(() => useStaleRefresh(false));
    live.result.current.onRun(POLLING);
    live.result.current.onFrames();
    const stale = renderHook(() => useStaleRefresh(true));
    stale.result.current.onRun(QUIET);
    // An ended run has no light to go stale, whatever its host.
    live.result.current.onRun({
      status: "sealed",
      commandBlock: "host_offline",
    });
    expect(navigate.refresh).not.toHaveBeenCalled();
  });

  it("asks again after the page's read landed and the reading changed once more", () => {
    const { result, rerender } = renderHook(
      ({ stale }: { stale: boolean }) => useStaleRefresh(stale),
      { initialProps: { stale: false } },
    );
    result.current.onRun(QUIET);
    rerender({ stale: true });
    // The page now agrees, so the stream's next row settles the reading.
    result.current.onRun(QUIET);
    result.current.onRun(POLLING);
    expect(navigate.refresh).toHaveBeenCalledTimes(2);
  });
});
