import { describe, expect, it } from "vitest";
import {
  type ColumnModel,
  type TableState,
  applyTableState,
  compareSortValues,
  facetOptions,
  nextSort,
  pageList,
} from "./data-table-model";

type Row = {
  id: string;
  name: string;
  status: string;
  micros: string;
  turns: number | null;
};

const rows: Row[] = [
  {
    id: "run_a",
    name: "Refetch the list",
    status: "sealed",
    micros: "4130000",
    turns: 7,
  },
  {
    id: "run_b",
    name: "Cache write",
    status: "live",
    micros: "9007199254740993",
    turns: 2,
  },
  {
    id: "run_c",
    name: "Bump deps",
    status: "halted",
    micros: "220000",
    turns: null,
  },
  {
    id: "run_d",
    name: "Add an index",
    status: "sealed",
    micros: "9007199254740992",
    turns: 11,
  },
  { id: "run_e", name: "run 10", status: "live", micros: "-500000", turns: 3 },
];

const columns: ColumnModel<Row>[] = [
  {
    id: "name",
    sortValue: (r) => r.name,
    searchValue: (r) => `${r.id} ${r.name}`,
  },
  { id: "status", facetValue: (r) => r.status },
  { id: "cost", sortValue: (r) => BigInt(r.micros) },
  { id: "turns", sortValue: (r) => r.turns },
];

const base: TableState = {
  query: "",
  sort: null,
  facets: {},
  pageSize: 0,
  page: 1,
};
const ids = (view: { rows: Row[] }) => view.rows.map((r) => r.id);

describe("compareSortValues", () => {
  it("compares bigints exactly past the float range", () => {
    expect(compareSortValues(9007199254740993n, 9007199254740992n)).toBe(1);
    expect(Number(9007199254740993n) === Number(9007199254740992n)).toBe(true);
  });

  it("orders strings naturally and case-insensitively", () => {
    expect(compareSortValues("run 9", "run 10")).toBeLessThan(0);
    expect(compareSortValues("alpha", "Alpha")).toBe(0);
  });

  it("puts empty values last", () => {
    expect(compareSortValues(null, 1)).toBe(1);
    expect(compareSortValues(1, undefined)).toBe(-1);
    expect(compareSortValues("", null)).toBe(0);
  });
});

describe("nextSort", () => {
  it("cycles ascending, descending, unsorted", () => {
    const asc = nextSort(null, "cost");
    expect(asc).toEqual({ columnId: "cost", direction: "asc" });
    const desc = nextSort(asc, "cost");
    expect(desc).toEqual({ columnId: "cost", direction: "desc" });
    expect(nextSort(desc, "cost")).toBeNull();
  });

  it("starts ascending when another column is clicked", () => {
    expect(nextSort({ columnId: "cost", direction: "desc" }, "name")).toEqual({
      columnId: "name",
      direction: "asc",
    });
  });
});

describe("applyTableState", () => {
  it("returns every row in source order with no state", () => {
    const view = applyTableState(rows, columns, base);
    expect(ids(view)).toEqual(["run_a", "run_b", "run_c", "run_d", "run_e"]);
    expect(view).toMatchObject({
      total: 5,
      page: 1,
      pageCount: 1,
      from: 1,
      to: 5,
    });
  });

  it("searches case-insensitively over the search text, including ids", () => {
    expect(
      ids(applyTableState(rows, columns, { ...base, query: "  CACHE " })),
    ).toEqual(["run_b"]);
    expect(
      ids(applyTableState(rows, columns, { ...base, query: "run_d" })),
    ).toEqual(["run_d"]);
  });

  it("searches facet values when a column has no search text", () => {
    expect(
      ids(applyTableState(rows, columns, { ...base, query: "halted" })),
    ).toEqual(["run_c"]);
  });

  it("filters by a facet and ignores a cleared facet", () => {
    expect(
      ids(
        applyTableState(rows, columns, { ...base, facets: { status: "live" } }),
      ),
    ).toEqual(["run_b", "run_e"]);
    expect(
      applyTableState(rows, columns, { ...base, facets: { status: "" } }).total,
    ).toBe(5);
  });

  it("sorts money as bigint micros, negative first", () => {
    const view = applyTableState(rows, columns, {
      ...base,
      sort: { columnId: "cost", direction: "asc" },
    });
    expect(ids(view)).toEqual(["run_e", "run_c", "run_a", "run_d", "run_b"]);
  });

  it("sorts descending and keeps empty values last in both directions", () => {
    const desc = applyTableState(rows, columns, {
      ...base,
      sort: { columnId: "turns", direction: "desc" },
    });
    expect(ids(desc)).toEqual(["run_d", "run_a", "run_e", "run_b", "run_c"]);
    const asc = applyTableState(rows, columns, {
      ...base,
      sort: { columnId: "turns", direction: "asc" },
    });
    expect(ids(asc).at(-1)).toBe("run_c");
  });

  it("ignores a sort on an unknown or unsortable column", () => {
    expect(
      ids(
        applyTableState(rows, columns, {
          ...base,
          sort: { columnId: "status", direction: "asc" },
        }),
      ),
    ).toEqual(ids(applyTableState(rows, columns, base)));
  });

  it("pages and clamps the page to the pages that exist", () => {
    const second = applyTableState(rows, columns, {
      ...base,
      pageSize: 2,
      page: 2,
    });
    expect(ids(second)).toEqual(["run_c", "run_d"]);
    expect(second).toMatchObject({ total: 5, pageCount: 3, from: 3, to: 4 });
    expect(
      applyTableState(rows, columns, { ...base, pageSize: 2, page: 9 }).page,
    ).toBe(3);
    expect(
      applyTableState(rows, columns, { ...base, pageSize: 2, page: -1 }).page,
    ).toBe(1);
  });

  it("reports 0 of 0 when nothing matches", () => {
    expect(
      applyTableState(rows, columns, {
        ...base,
        query: "nothing",
        pageSize: 10,
      }),
    ).toMatchObject({
      rows: [],
      total: 0,
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
    });
  });

  it("does not mutate the rows it is given", () => {
    const copy = [...rows];
    applyTableState(rows, columns, {
      ...base,
      sort: { columnId: "name", direction: "desc" },
    });
    expect(rows).toEqual(copy);
  });
});

describe("facetOptions", () => {
  it("lists distinct values in natural order", () => {
    expect(facetOptions(rows, columns[1] as ColumnModel<Row>)).toEqual([
      "halted",
      "live",
      "sealed",
    ]);
  });

  it("is empty for a column with no facet", () => {
    expect(facetOptions(rows, columns[0] as ColumnModel<Row>)).toEqual([]);
  });
});

describe("pageList", () => {
  it("lists every page up to seven", () => {
    expect(pageList(1, 1)).toEqual([1]);
    expect(pageList(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("collapses the middle with gaps beyond seven", () => {
    expect(pageList(1, 20)).toEqual([1, 2, "gap", 20]);
    expect(pageList(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
    expect(pageList(20, 20)).toEqual([1, "gap", 19, 20]);
    expect(pageList(3, 8)).toEqual([1, 2, 3, 4, "gap", 8]);
  });
});
