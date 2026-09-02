// @vitest-environment jsdom
/**
 * use-recent.test.ts — unit tests for useRecent hook and the pure helpers
 * readRecent / pushRecent (tested indirectly through the hook).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRecent } from "./use-recent";

// ---------------------------------------------------------------------------
// Reset localStorage before each test.
// ---------------------------------------------------------------------------
beforeEach(() => {
  localStorage.clear();
});

describe("useRecent — initial state", () => {
  it("returns an empty list when localStorage is clean", () => {
    const { result } = renderHook(() => useRecent());
    expect(result.current.recent).toEqual([]);
  });

  it("reads existing entries from localStorage on mount", () => {
    localStorage.setItem(
      "oxagen:ask:recent",
      JSON.stringify([
        { query: "prior query", at: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    const { result } = renderHook(() => useRecent());
    expect(result.current.recent).toHaveLength(1);
    expect(result.current.recent[0]!.query).toBe("prior query");
  });
});

describe("useRecent — push", () => {
  it("adds a new entry to the top of the list", () => {
    const { result } = renderHook(() => useRecent());
    act(() => {
      result.current.push("new query");
    });
    expect(result.current.recent[0]!.query).toBe("new query");
  });

  it("deduplicates: moves an existing query to the front", () => {
    localStorage.setItem(
      "oxagen:ask:recent",
      JSON.stringify([
        { query: "first", at: "2026-01-01T00:00:00.000Z" },
        { query: "second", at: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    const { result } = renderHook(() => useRecent());
    act(() => {
      result.current.push("second");
    });
    expect(result.current.recent[0]!.query).toBe("second");
    expect(result.current.recent[1]!.query).toBe("first");
    expect(result.current.recent).toHaveLength(2);
  });

  it("caps the list at 5 entries", () => {
    localStorage.setItem(
      "oxagen:ask:recent",
      JSON.stringify([
        { query: "a", at: "2026-01-01T00:00:00.000Z" },
        { query: "b", at: "2026-01-01T00:00:00.000Z" },
        { query: "c", at: "2026-01-01T00:00:00.000Z" },
        { query: "d", at: "2026-01-01T00:00:00.000Z" },
        { query: "e", at: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    const { result } = renderHook(() => useRecent());
    act(() => {
      result.current.push("f");
    });
    expect(result.current.recent).toHaveLength(5);
    expect(result.current.recent[0]!.query).toBe("f");
    // "e" (the oldest) should have been evicted
    expect(result.current.recent.map((r) => r.query)).not.toContain("e");
  });

  it("ignores blank / whitespace-only queries", () => {
    const { result } = renderHook(() => useRecent());
    act(() => {
      result.current.push("   ");
    });
    expect(result.current.recent).toHaveLength(0);
  });

  it("trims whitespace from the query before storing", () => {
    const { result } = renderHook(() => useRecent());
    act(() => {
      result.current.push("  hello world  ");
    });
    expect(result.current.recent[0]!.query).toBe("hello world");
  });

  it("persists entries to localStorage", () => {
    const { result } = renderHook(() => useRecent());
    act(() => {
      result.current.push("persisted");
    });
    const stored = JSON.parse(
      localStorage.getItem("oxagen:ask:recent") ?? "[]",
    ) as { query: string }[];
    expect(stored[0]!.query).toBe("persisted");
  });

  it("each entry has an 'at' ISO timestamp", () => {
    const { result } = renderHook(() => useRecent());
    act(() => {
      result.current.push("timestamped");
    });
    const at = result.current.recent[0]!.at;
    expect(() => new Date(at)).not.toThrow();
    expect(new Date(at).toISOString()).toBe(at);
  });
});

describe("useRecent — clear", () => {
  it("empties the list", () => {
    localStorage.setItem(
      "oxagen:ask:recent",
      JSON.stringify([{ query: "something", at: "2026-01-01T00:00:00.000Z" }]),
    );
    const { result } = renderHook(() => useRecent());
    expect(result.current.recent).toHaveLength(1);
    act(() => {
      result.current.clear();
    });
    expect(result.current.recent).toHaveLength(0);
  });

  it("removes the localStorage key", () => {
    localStorage.setItem(
      "oxagen:ask:recent",
      JSON.stringify([{ query: "x", at: "" }]),
    );
    const { result } = renderHook(() => useRecent());
    act(() => {
      result.current.clear();
    });
    expect(localStorage.getItem("oxagen:ask:recent")).toBeNull();
  });
});

describe("useRecent — corrupt localStorage", () => {
  it("degrades gracefully when localStorage contains invalid JSON", () => {
    localStorage.setItem("oxagen:ask:recent", "NOT_JSON");
    const { result } = renderHook(() => useRecent());
    expect(result.current.recent).toEqual([]);
  });

  it("degrades gracefully when localStorage contains a non-array JSON value", () => {
    localStorage.setItem("oxagen:ask:recent", JSON.stringify({ wrong: true }));
    const { result } = renderHook(() => useRecent());
    expect(result.current.recent).toEqual([]);
  });
});
