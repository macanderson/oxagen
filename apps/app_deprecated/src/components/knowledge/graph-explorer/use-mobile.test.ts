// @vitest-environment jsdom
/**
 * use-mobile.test.ts — the explorer's viewport/hover media-query hooks.
 *
 * Covers: false fallback when matchMedia is unavailable (SSR/jsdom default),
 * initial match reporting, live updates via the change listener (both the
 * modern addEventListener and the legacy addListener API shapes), and the
 * specific queries each convenience hook watches.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  useMediaQuery,
  useIsMobile,
  useIsCompact,
  useHasHover,
} from "./use-mobile";

type Listener = () => void;

interface MatchMediaController {
  set: (matches: boolean) => void;
  queries: string[];
}

function installMatchMedia(
  initial: boolean,
  { legacy = false }: { legacy?: boolean } = {},
): MatchMediaController {
  let matches = initial;
  const listeners = new Set<Listener>();
  const queries: string[] = [];

  const modern = {
    addEventListener: (_type: string, cb: Listener) => listeners.add(cb),
    removeEventListener: (_type: string, cb: Listener) => listeners.delete(cb),
  };
  const legacyApi = {
    addListener: (cb: Listener) => listeners.add(cb),
    removeListener: (cb: Listener) => listeners.delete(cb),
  };

  window.matchMedia = ((query: string) => {
    queries.push(query);
    return {
      get matches() {
        return matches;
      },
      media: query,
      onchange: null,
      dispatchEvent: () => false,
      ...(legacy ? legacyApi : { ...modern, ...legacyApi }),
    };
  }) as unknown as typeof window.matchMedia;

  return {
    set(value: boolean) {
      matches = value;
      act(() => {
        for (const cb of [...listeners]) cb();
      });
    },
    queries,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("useMediaQuery", () => {
  it("returns false when window.matchMedia is unavailable", () => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    const { result } = renderHook(() => useMediaQuery("(max-width: 1023px)"));
    expect(result.current).toBe(false);
  });

  it("reports the initial match state", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery("(max-width: 1023px)"));
    expect(result.current).toBe(true);
  });

  it("updates when the media query match changes", () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery("(max-width: 1023px)"));
    expect(result.current).toBe(false);
    media.set(true);
    expect(result.current).toBe(true);
    media.set(false);
    expect(result.current).toBe(false);
  });

  it("falls back to the legacy addListener API when addEventListener is absent", () => {
    const media = installMatchMedia(false, { legacy: true });
    const { result } = renderHook(() => useMediaQuery("(max-width: 767px)"));
    expect(result.current).toBe(false);
    media.set(true);
    expect(result.current).toBe(true);
  });
});

describe("convenience hooks", () => {
  it("useIsMobile watches the below-lg breakpoint", () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
    expect(media.queries).toContain("(max-width: 1023px)");
  });

  it("useIsCompact watches the below-md breakpoint", () => {
    const media = installMatchMedia(true);
    const { result } = renderHook(() => useIsCompact());
    expect(result.current).toBe(true);
    expect(media.queries).toContain("(max-width: 767px)");
  });

  it("useHasHover watches the hover capability", () => {
    const media = installMatchMedia(false);
    const { result } = renderHook(() => useHasHover());
    expect(result.current).toBe(false);
    expect(media.queries).toContain("(hover: hover)");
  });
});
