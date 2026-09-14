// @vitest-environment jsdom
/**
 * use-media-query.test.ts
 *
 * Unit tests for useMediaQuery / useIsMobile:
 *   - Returns the current matchMedia match state
 *   - Reacts to `change` events (viewport resize / rotation)
 *   - Unsubscribes the change listener on unmount
 *   - Degrades to false when window.matchMedia is unavailable (SSR-ish envs)
 *   - useIsMobile queries the documented phone breakpoint
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  useMediaQuery,
  useIsMobile,
  MOBILE_BREAKPOINT_QUERY,
} from "./use-media-query";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type ChangeListener = (e: MediaQueryListEvent) => void;

/** Minimal MediaQueryList stub with controllable `matches` + change events. */
function stubMatchMedia(initialMatches: boolean) {
  const listenersByQuery = new Map<string, Set<ChangeListener>>();
  let matches = initialMatches;
  const queries: string[] = [];

  const matchMedia = vi.fn((query: string) => {
    queries.push(query);
    const listeners =
      listenersByQuery.get(query) ??
      listenersByQuery.set(query, new Set()).get(query)!;
    return {
      matches,
      media: query,
      addEventListener: (_: "change", cb: ChangeListener) => listeners.add(cb),
      removeEventListener: (_: "change", cb: ChangeListener) =>
        listeners.delete(cb),
    } as unknown as MediaQueryList;
  });

  vi.stubGlobal("matchMedia", matchMedia);

  return {
    matchMedia,
    queries,
    setMatches(next: boolean) {
      matches = next;
      for (const listeners of listenersByQuery.values()) {
        for (const cb of listeners)
          cb({ matches: next } as MediaQueryListEvent);
      }
    },
    listenerCount(query: string) {
      return listenersByQuery.get(query)?.size ?? 0;
    },
  };
}

describe("useMediaQuery", () => {
  it("returns false when the query does not match", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);
  });

  it("returns true when the query matches", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the media query match state changes", () => {
    const stub = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);
    act(() => stub.setMatches(true));
    expect(result.current).toBe(true);
    act(() => stub.setMatches(false));
    expect(result.current).toBe(false);
  });

  it("removes the change listener on unmount", () => {
    const stub = stubMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(stub.listenerCount("(max-width: 767px)")).toBe(1);
    unmount();
    expect(stub.listenerCount("(max-width: 767px)")).toBe(0);
  });

  it("re-subscribes when the query string changes", () => {
    const stub = stubMatchMedia(false);
    const { rerender } = renderHook(({ q }) => useMediaQuery(q), {
      initialProps: { q: "(max-width: 767px)" },
    });
    rerender({ q: "(min-width: 1024px)" });
    expect(stub.listenerCount("(max-width: 767px)")).toBe(0);
    expect(stub.listenerCount("(min-width: 1024px)")).toBe(1);
  });

  it("returns false when window.matchMedia is unavailable", () => {
    // jsdom has no native matchMedia; ensure none is stubbed.
    expect(typeof window.matchMedia).toBe("undefined");
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);
  });
});

describe("useIsMobile", () => {
  it("uses the documented mobile breakpoint query", () => {
    const stub = stubMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
    expect(stub.queries).toContain(MOBILE_BREAKPOINT_QUERY);
    expect(MOBILE_BREAKPOINT_QUERY).toBe("(max-width: 767px)");
  });

  it("returns false on desktop widths", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });
});
