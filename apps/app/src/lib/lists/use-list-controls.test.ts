// @vitest-environment jsdom
/**
 * use-list-controls.test.ts — search, sort, and pagination behavior of
 * useListControls.
 */

import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useListControls, type ListSortOption } from "./use-list-controls";

interface Row {
  id: number;
  name: string;
  owner: { email: string };
}

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: `Item ${String(i + 1).padStart(2, "0")}`,
    owner: { email: `owner${i + 1}@example.com` },
  }));
}

const SORT_BY_NAME: ListSortOption<Row> = {
  id: "name",
  label: "Name",
  compare: (a, b) => a.name.localeCompare(b.name),
};

const SORT_BY_NAME_DESC: ListSortOption<Row> = {
  id: "name-desc",
  label: "Name (desc)",
  compare: (a, b) => b.name.localeCompare(a.name),
};

describe("useListControls — search", () => {
  it("matches a string search key case-insensitively", () => {
    const rows = makeRows(3);
    const { result } = renderHook(() =>
      useListControls(rows, { searchKeys: ["name"], sortOptions: [] }),
    );
    act(() => result.current.setQuery("item 02"));
    expect(result.current.pageRows.map((r) => r.id)).toEqual([2]);
    expect(result.current.filteredTotal).toBe(1);
    expect(result.current.total).toBe(3);
  });

  it("matches a function-derived search key", () => {
    const rows = makeRows(3);
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: [(row: Row) => row.owner.email],
        sortOptions: [],
      }),
    );
    act(() => result.current.setQuery("OWNER2@"));
    expect(result.current.pageRows.map((r) => r.id)).toEqual([2]);
  });

  it("matches if ANY search key matches", () => {
    const rows = makeRows(3);
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: ["name", (row: Row) => row.owner.email],
        sortOptions: [],
      }),
    );
    act(() => result.current.setQuery("owner3"));
    expect(result.current.pageRows.map((r) => r.id)).toEqual([3]);
  });

  it("returns all rows for an empty/whitespace query", () => {
    const rows = makeRows(3);
    const { result } = renderHook(() =>
      useListControls(rows, { searchKeys: ["name"], sortOptions: [] }),
    );
    act(() => result.current.setQuery("   "));
    expect(result.current.filteredTotal).toBe(3);
  });
});

describe("useListControls — sort", () => {
  it("applies defaultSortId on first render", () => {
    const rows = [makeRows(3)[2]!, makeRows(3)[0]!, makeRows(3)[1]!];
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: ["name"],
        sortOptions: [SORT_BY_NAME, SORT_BY_NAME_DESC],
        defaultSortId: "name",
      }),
    );
    expect(result.current.sortId).toBe("name");
    expect(result.current.allFilteredRows.map((r) => r.name)).toEqual([
      "Item 01",
      "Item 02",
      "Item 03",
    ]);
  });

  it("falls back to the first sort option when defaultSortId is omitted", () => {
    const rows = makeRows(2);
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: ["name"],
        sortOptions: [SORT_BY_NAME_DESC, SORT_BY_NAME],
      }),
    );
    expect(result.current.sortId).toBe("name-desc");
  });

  it("leaves sortId undefined and preserves source order with no sortOptions", () => {
    const rows = makeRows(3);
    const { result } = renderHook(() =>
      useListControls(rows, { searchKeys: ["name"], sortOptions: [] }),
    );
    expect(result.current.sortId).toBeUndefined();
    expect(result.current.allFilteredRows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it("re-sorts when setSortId is called", () => {
    const rows = makeRows(3);
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: ["name"],
        sortOptions: [SORT_BY_NAME, SORT_BY_NAME_DESC],
      }),
    );
    act(() => result.current.setSortId("name-desc"));
    expect(result.current.sortId).toBe("name-desc");
    expect(result.current.allFilteredRows.map((r) => r.name)).toEqual([
      "Item 03",
      "Item 02",
      "Item 01",
    ]);
  });
});

describe("useListControls — pagination", () => {
  it("defaults to a page size of 12", () => {
    const rows = makeRows(25);
    const { result } = renderHook(() =>
      useListControls(rows, { searchKeys: ["name"], sortOptions: [] }),
    );
    expect(result.current.pageRows).toHaveLength(12);
    expect(result.current.pageCount).toBe(3);
  });

  it("honors a custom pageSize", () => {
    const rows = makeRows(10);
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: ["name"],
        sortOptions: [],
        pageSize: 4,
      }),
    );
    expect(result.current.pageCount).toBe(3);
    expect(result.current.pageRows).toHaveLength(4);
  });

  it("navigates pages via setPage", () => {
    const rows = makeRows(10);
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: ["name"],
        sortOptions: [],
        pageSize: 4,
      }),
    );
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);
    expect(result.current.pageRows.map((r) => r.id)).toEqual([9, 10]);
  });

  it("clamps setPage to at least 1", () => {
    const rows = makeRows(10);
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: ["name"],
        sortOptions: [],
        pageSize: 4,
      }),
    );
    act(() => result.current.setPage(-5));
    expect(result.current.page).toBe(1);
  });

  it("clamps the page down when a new search query shrinks the result set", () => {
    const rows = makeRows(10);
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: ["name"],
        sortOptions: [],
        pageSize: 4,
      }),
    );
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);

    act(() => result.current.setQuery("Item 01"));
    expect(result.current.filteredTotal).toBe(1);
    expect(result.current.pageCount).toBe(1);
    expect(result.current.page).toBe(1);
  });

  it("clamps the page down when the underlying rows array shrinks", () => {
    const rows = makeRows(10);
    const { result, rerender } = renderHook(
      ({ rows }) =>
        useListControls(rows, {
          searchKeys: ["name"],
          sortOptions: [],
          pageSize: 4,
        }),
      { initialProps: { rows } },
    );
    act(() => result.current.setPage(3));
    expect(result.current.page).toBe(3);

    rerender({ rows: makeRows(4) });
    expect(result.current.pageCount).toBe(1);
    expect(result.current.page).toBe(1);
  });

  it("exposes allFilteredRows as the full unpaginated, filtered+sorted set", () => {
    const rows = makeRows(10);
    const { result } = renderHook(() =>
      useListControls(rows, {
        searchKeys: ["name"],
        sortOptions: [SORT_BY_NAME_DESC],
        pageSize: 4,
      }),
    );
    expect(result.current.allFilteredRows).toHaveLength(10);
    expect(result.current.pageRows).toHaveLength(4);
    expect(result.current.allFilteredRows[0]?.name).toBe("Item 10");
  });
});
