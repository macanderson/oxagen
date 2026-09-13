// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable, type DataTableColumn } from "./data-table";
import { renderWithIntl } from "./testing/render-with-intl";

type Row = { id: string; name: string; status: string; micros: string };

const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
  id: `run_${String(i + 1).padStart(2, "0")}`,
  name: `Run ${String(i + 1)}`,
  status: i % 3 === 0 ? "live" : "sealed",
  micros: String((12 - i) * 1_000_000),
}));

const columns: DataTableColumn<Row>[] = [
  {
    id: "name",
    header: "Run",
    cell: (r) => r.name,
    sortValue: (r) => r.name,
    searchValue: (r) => `${r.id} ${r.name}`,
  },
  {
    id: "status",
    header: "Status",
    cell: (r) => r.status,
    facetValue: (r) => r.status,
    facetLabel: (v) => v.toUpperCase(),
  },
  {
    id: "cost",
    header: "Cost",
    cell: (r) => r.micros,
    sortValue: (r) => BigInt(r.micros),
    align: "end",
  },
];

afterEach(() => {
  cleanup();
});

function bodyRowNames(): string[] {
  const table = screen.getByRole("table", { name: "Runs" });
  const [, body] = within(table).getAllByRole("rowgroup");
  return within(body as HTMLElement)
    .getAllByRole("row")
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}

function renderTable(
  props: Partial<Parameters<typeof DataTable<Row>>[0]> = {},
) {
  return renderWithIntl(
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={(r) => r.id}
      caption="Runs"
      search={{}}
      pageSizes={[5, 10, 0]}
      {...props}
    />,
  );
}

describe("<DataTable>", () => {
  it("names the table and shows the first page with its range", () => {
    renderTable();
    expect(bodyRowNames()).toEqual([
      "Run 1",
      "Run 2",
      "Run 3",
      "Run 4",
      "Run 5",
    ]);
    expect(screen.getByTestId("data-table-range")).toHaveTextContent(
      "1–5 of 12",
    );
    expect(screen.getByRole("button", { name: "Page 1" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
  });

  it("searches and returns to the first page", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole("button", { name: "Page 2" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "run_11",
    );
    expect(bodyRowNames()).toEqual(["Run 11"]);
    expect(screen.getByTestId("data-table-range")).toHaveTextContent(
      "1–1 of 1",
    );
  });

  it("says no rows match when a search hides everything", async () => {
    const user = userEvent.setup();
    renderTable({ search: { placeholder: "Search runs" } });
    await user.type(
      screen.getByRole("searchbox", { name: "Search runs" }),
      "zzz",
    );
    expect(screen.getByText("No rows match.")).toBeVisible();
    expect(screen.getByTestId("data-table-range")).toHaveTextContent(
      "0–0 of 0",
    );
  });

  it("sorts by a header: ascending, descending, then back to source order", async () => {
    const user = userEvent.setup();
    renderTable({ pageSizes: [0] });
    const header = screen.getByRole("columnheader", { name: "Cost" });
    expect(header).toHaveAttribute("aria-sort", "none");
    const button = within(header).getByRole("button", { name: "Cost" });

    await user.click(button);
    expect(header).toHaveAttribute("aria-sort", "ascending");
    expect(bodyRowNames()[0]).toBe("Run 12");

    await user.click(button);
    expect(header).toHaveAttribute("aria-sort", "descending");
    expect(bodyRowNames()[0]).toBe("Run 1");

    await user.click(button);
    expect(header).toHaveAttribute("aria-sort", "none");
    expect(bodyRowNames()[0]).toBe("Run 1");
    expect(bodyRowNames()[11]).toBe("Run 12");
  });

  it("gives an unsortable column no sort control", () => {
    renderTable();
    const header = screen.getByRole("columnheader", { name: "Status" });
    expect(header).not.toHaveAttribute("aria-sort");
    expect(within(header).queryByRole("button")).toBeNull();
  });

  it("filters by a facet with translated option labels", async () => {
    const user = userEvent.setup();
    renderTable({ pageSizes: [0] });
    const facet = screen.getByRole("combobox", { name: "Filter by Status" });
    expect(
      within(facet)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["All · Status", "LIVE", "SEALED"]);
    await user.selectOptions(facet, "live");
    expect(bodyRowNames()).toEqual(["Run 1", "Run 4", "Run 7", "Run 10"]);
    await user.selectOptions(facet, "");
    expect(bodyRowNames()).toHaveLength(12);
  });

  it("changes rows per page, including all", async () => {
    const user = userEvent.setup();
    renderTable();
    const perPage = screen.getByRole("combobox", { name: "Rows" });
    await user.selectOptions(perPage, "10");
    expect(bodyRowNames()).toHaveLength(10);
    expect(screen.getByTestId("data-table-range")).toHaveTextContent(
      "1–10 of 12",
    );
    await user.selectOptions(perPage, "0");
    expect(bodyRowNames()).toHaveLength(12);
    expect(screen.queryByRole("button", { name: "Page 2" })).toBeNull();
  });

  it("pages forward and back", async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(bodyRowNames()[0]).toBe("Run 6");
    await user.click(screen.getByRole("button", { name: "Page 3" }));
    expect(bodyRowNames()).toEqual(["Run 11", "Run 12"]);
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Previous page" }));
    expect(bodyRowNames()[0]).toBe("Run 6");
  });

  it("drops every control whose config is omitted", () => {
    renderWithIntl(
      <DataTable
        rows={rows}
        columns={columns.map(
          ({ sortValue: _s, facetValue: _f, ...rest }) => rest,
        )}
        getRowId={(r) => r.id}
        caption="Runs"
      />,
    );
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(bodyRowNames()).toHaveLength(12);
  });

  it("renders the empty slot instead of a table when there are no rows", () => {
    renderTable({ rows: [], empty: <p>No runs yet</p> });
    expect(screen.getByText("No runs yet")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("applies an initial sort and a visible caption", () => {
    renderTable({
      initialSort: { columnId: "cost", direction: "asc" },
      showCaption: true,
      pageSizes: [0],
    });
    expect(bodyRowNames()[0]).toBe("Run 12");
    expect(screen.getByText("Runs")).not.toHaveClass("sr-only");
  });
});
