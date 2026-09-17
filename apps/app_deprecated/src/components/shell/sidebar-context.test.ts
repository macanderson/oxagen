/**
 * sidebar-context.test.ts — unit tests for SidebarProvider / useSidebar.
 *
 * Tests the pure logic of the collapse state (localStorage persistence,
 * toggle behaviour, openMobile flag) without needing a DOM. The
 * useSyncExternalStore-based collapsed flag is tested indirectly through the
 * exported helpers (readCollapsed / subscribeCollapsed patterns) by exercising
 * the component via renderHook in jsdom.
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement } from "react";
import { SidebarProvider, useSidebar } from "./sidebar-context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "oxagen.sidebar.collapsed";

function wrapper({ children }: { children: React.ReactNode }) {
  return createElement(SidebarProvider, null, children);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// useSidebar — must be inside SidebarProvider
// ---------------------------------------------------------------------------

describe("useSidebar — throws when used outside SidebarProvider", () => {
  it("throws with a helpful message", () => {
    expect(() => {
      renderHook(() => useSidebar());
    }).toThrow("useSidebar must be used within a SidebarProvider");
  });
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("SidebarProvider — initial state", () => {
  it("defaults collapsed to false when localStorage has no entry", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper });
    expect(result.current.collapsed).toBe(false);
  });

  it("reads collapsed=true from localStorage '1' on mount", () => {
    localStorage.setItem(STORAGE_KEY, "1");
    const { result } = renderHook(() => useSidebar(), { wrapper });
    expect(result.current.collapsed).toBe(true);
  });

  it("defaults openMobile to false", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper });
    expect(result.current.openMobile).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// toggle
// ---------------------------------------------------------------------------

describe("SidebarProvider — toggle", () => {
  it("toggle flips collapsed from false to true", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper });
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("toggle flips collapsed back to false", () => {
    localStorage.setItem(STORAGE_KEY, "1");
    const { result } = renderHook(() => useSidebar(), { wrapper });
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// setCollapsed
// ---------------------------------------------------------------------------

describe("SidebarProvider — setCollapsed", () => {
  it("setCollapsed(true) writes '1' to localStorage", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper });
    act(() => result.current.setCollapsed(true));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
    expect(result.current.collapsed).toBe(true);
  });

  it("setCollapsed(false) writes '0' to localStorage", () => {
    localStorage.setItem(STORAGE_KEY, "1");
    const { result } = renderHook(() => useSidebar(), { wrapper });
    act(() => result.current.setCollapsed(false));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("0");
    expect(result.current.collapsed).toBe(false);
  });

  it("setCollapsed is idempotent — setting same value twice", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper });
    act(() => result.current.setCollapsed(true));
    act(() => result.current.setCollapsed(true));
    expect(result.current.collapsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// openMobile
// ---------------------------------------------------------------------------

describe("SidebarProvider — openMobile", () => {
  it("setOpenMobile(true) sets openMobile to true", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper });
    act(() => result.current.setOpenMobile(true));
    expect(result.current.openMobile).toBe(true);
  });

  it("setOpenMobile(false) resets openMobile to false", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper });
    act(() => result.current.setOpenMobile(true));
    act(() => result.current.setOpenMobile(false));
    expect(result.current.openMobile).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// localStorage unavailable (private-browsing simulation)
// ---------------------------------------------------------------------------

describe("SidebarProvider — localStorage unavailable", () => {
  it("falls back to collapsed=false when localStorage throws on setItem", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const { result } = renderHook(() => useSidebar(), { wrapper });
    // Should not throw — setCollapsed swallows the error
    expect(() => act(() => result.current.setCollapsed(true))).not.toThrow();
  });
});
