// @vitest-environment jsdom
// ListTable (list-table.tsx): the design's list controls over a table. Search
// narrows the rows to those whose rendered text holds the query; a header
// sorts its column ascending, then descending, then back to the caller's
// order, as a number when the column is numeric; Rows sets the page size and
// the pager walks the pages. A hidden column names itself through aria-label
// and carries no text. Every test ends in an axe check.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { type ListRow, ListTable, leadingNumber } from "./list-table";

const COLUMNS = [
  { label: "Invoice" },
  { label: "Amount", numeric: true },
  { label: "Open in Stripe", hidden: true },
];

const rowsOf = (n: number): ListRow[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `inv_${String(i + 1)}`,
    data: { "data-n": String(i + 1) },
    cells: [
      `OXA-${String(i + 1).padStart(3, "0")}`,
      `$${String((i + 1) * 3)},000.00`,
      <a key="link" href="https://invoice.stripe.com/">
        Open in Stripe ↗
      </a>,
    ],
  }));

function renderList(rows: ListRow[]) {
  render(
    <IntlProvider>
      <ListTable label="Invoices" columns={COLUMNS} rows={rows} />
    </IntlProvider>,
  );
}

/** The rows a reader sees, by their first cell. */
const visible = () =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .slice(1)
    .filter((tr) => tr.style.display !== "none")
    .map((tr) => tr.querySelector("td")?.textContent);

const pager = () => screen.getByRole("navigation", { name: "Invoices pages" });

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("ListTable", () => {
  it("draws the search box, Rows at 10, the table and a 1–N of N pager", () => {
    renderList(rowsOf(3));
    expect(
      screen.getByRole("searchbox", { name: "Search this list" }),
    ).toHaveAttribute("placeholder", "Search this list");
    const rows = screen.getByRole("combobox", { name: "Rows" });
    expect(rows).toHaveValue("10");
    expect(
      within(rows)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["5", "10", "25", "50", "All"]);
    expect(visible()).toEqual(["OXA-001", "OXA-002", "OXA-003"]);
    expect(pager()).toHaveTextContent("1–3 of 3");
    expect(within(pager()).getByRole("button", { name: "1" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(pager()).getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(
      within(pager()).getByRole("button", { name: "Next page" }),
    ).toBeDisabled();
  });

  it("carries each row's data attributes", () => {
    renderList(rowsOf(2));
    expect(document.querySelector('[data-n="2"]')).toHaveTextContent("OXA-002");
  });

  it("names a hidden column through aria-label and gives it no text or sort button", () => {
    renderList(rowsOf(1));
    const th = screen.getByRole("columnheader", { name: "Open in Stripe" });
    expect(th).toHaveTextContent("");
    expect(within(th).queryByRole("button")).toBeNull();
  });

  it("narrows the rows to those whose text holds the query, and says when none do", async () => {
    renderList(rowsOf(12));
    const search = screen.getByRole("searchbox", { name: "Search this list" });
    await userEvent.type(search, "oxa-01");
    expect(visible()).toEqual(["OXA-010", "OXA-011", "OXA-012"]);
    expect(pager()).toHaveTextContent("1–3 of 3");
    await userEvent.clear(search);
    await userEvent.type(search, "nothing here");
    expect(screen.getByText("No rows match.")).toBeInTheDocument();
    expect(pager()).toHaveTextContent("0 of 0");
  });

  it("sorts a numeric column as numbers: ascending, descending, then the given order", async () => {
    renderList(rowsOf(12));
    const amount = screen.getByRole("button", { name: "Amount" });
    await userEvent.click(amount);
    expect(
      screen.getByRole("columnheader", { name: "Amount" }),
    ).toHaveAttribute("aria-sort", "ascending");
    expect(visible()[0]).toBe("OXA-001");
    await userEvent.click(amount);
    expect(
      screen.getByRole("columnheader", { name: "Amount" }),
    ).toHaveAttribute("aria-sort", "descending");
    // $36,000 before $9,000: compared as numbers, not as text.
    expect(visible().slice(0, 2)).toEqual(["OXA-012", "OXA-011"]);
    await userEvent.click(amount);
    expect(
      screen.getByRole("columnheader", { name: "Amount" }),
    ).toHaveAttribute("aria-sort", "none");
    expect(visible()[0]).toBe("OXA-001");
  });

  it("pages by the Rows size and walks the pages", async () => {
    renderList(rowsOf(12));
    expect(visible()).toHaveLength(10);
    await userEvent.click(
      within(pager()).getByRole("button", { name: "Next page" }),
    );
    expect(visible()).toEqual(["OXA-011", "OXA-012"]);
    expect(pager()).toHaveTextContent("11–12 of 12");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Rows" }),
      "5",
    );
    expect(visible()).toHaveLength(5);
    expect(pager()).toHaveTextContent("1–5 of 12");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Rows" }),
      "All",
    );
    expect(visible()).toHaveLength(12);
    expect(pager()).toHaveTextContent("1–12 of 12");
  });
});

describe("ListTable past the first screen", () => {
  /** The pager's page buttons and gaps, in order. */
  const pageItems = () =>
    [...pager().querySelectorAll("span.ml-auto > *")]
      .slice(1, -1)
      .map((el) => el.textContent);

  it("shows the first, the last and the pages beside the current one past seven pages, with a gap for the rest", async () => {
    renderList(rowsOf(100));
    expect(pageItems()).toEqual(["1", "2", "…", "10"]);
    await userEvent.click(within(pager()).getByRole("button", { name: "2" }));
    await userEvent.click(within(pager()).getByRole("button", { name: "3" }));
    await userEvent.click(within(pager()).getByRole("button", { name: "4" }));
    await userEvent.click(within(pager()).getByRole("button", { name: "5" }));
    expect(pageItems()).toEqual(["1", "…", "4", "5", "6", "…", "10"]);
    expect(pager()).toHaveTextContent("41–50 of 100");
    await userEvent.click(within(pager()).getByRole("button", { name: "10" }));
    expect(pageItems()).toEqual(["1", "…", "9", "10"]);
    expect(
      within(pager()).getByRole("button", { name: "Next page" }),
    ).toBeDisabled();
  });

  it("keeps a row off the page in the document, hidden, so what it holds survives a page turn", async () => {
    renderList(rowsOf(12));
    await userEvent.click(
      within(pager()).getByRole("button", { name: "Next page" }),
    );
    const first = document.querySelector<HTMLElement>('[data-n="1"]');
    expect(first).not.toBeNull();
    expect(first?.style.display).toBe("none");
  });

  it("sorts a text column as text, and a second column starts ascending again", async () => {
    renderList(rowsOf(12));
    const invoice = screen.getByRole("button", { name: "Invoice" });
    await userEvent.click(invoice);
    await userEvent.click(invoice);
    expect(
      screen.getByRole("columnheader", { name: "Invoice" }),
    ).toHaveAttribute("aria-sort", "descending");
    expect(visible().slice(0, 2)).toEqual(["OXA-012", "OXA-011"]);
    await userEvent.click(screen.getByRole("button", { name: "Amount" }));
    expect(
      screen.getByRole("columnheader", { name: "Invoice" }),
    ).toHaveAttribute("aria-sort", "none");
    expect(
      screen.getByRole("columnheader", { name: "Amount" }),
    ).toHaveAttribute("aria-sort", "ascending");
    expect(visible()[0]).toBe("OXA-001");
  });

  it("sorts a figure that is not recorded after every number ascending, and so first descending", async () => {
    // A characterization: the direction flips the whole comparison, so a
    // "not recorded" cell leads the descending order rather than trailing it.
    renderList([
      { key: "a", cells: ["A", "$5.00", null] },
      { key: "b", cells: ["B", "not recorded", null] },
      { key: "c", cells: ["C", "$1.00", null] },
    ]);
    const amount = screen.getByRole("button", { name: "Amount" });
    await userEvent.click(amount);
    expect(visible()).toEqual(["C", "A", "B"]);
    await userEvent.click(amount);
    expect(visible()).toEqual(["B", "A", "C"]);
  });

  it("keeps a row that arrived after the last search in the list until the reader searches again", async () => {
    const { rerender } = render(
      <IntlProvider>
        <ListTable label="Invoices" columns={COLUMNS} rows={rowsOf(3)} />
      </IntlProvider>,
    );
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "oxa-001",
    );
    expect(visible()).toEqual(["OXA-001"]);
    rerender(
      <IntlProvider>
        <ListTable
          label="Invoices"
          columns={COLUMNS}
          rows={[
            ...rowsOf(3),
            { key: "late", cells: ["LATE-1", "$1.00", null] },
          ]}
        />
      </IntlProvider>,
    );
    expect(visible()).toEqual(["OXA-001", "LATE-1"]);
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      " ",
    );
    expect(visible()).toEqual(["OXA-001"]);
  });
});

describe("ListTable: a caller's filters and empty line", () => {
  it("draws the caller's filters between the search box and Rows", () => {
    render(
      <IntlProvider>
        <ListTable
          label="Invoices"
          columns={COLUMNS}
          rows={rowsOf(2)}
          filters={
            <select aria-label="Status">
              <option>All · Status</option>
            </select>
          }
        />
      </IntlProvider>,
    );
    const search = screen.getByRole("searchbox", { name: "Search this list" });
    const status = screen.getByRole("combobox", { name: "Status" });
    const rows = screen.getByRole("combobox", { name: "Rows" });
    expect(
      search.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      status.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("prints the caller's line when no row shows (negative)", () => {
    render(
      <IntlProvider>
        <ListTable
          label="Invoices"
          columns={COLUMNS}
          rows={[]}
          empty="No invoice has been issued."
        />
      </IntlProvider>,
    );
    expect(screen.getByText("No invoice has been issued.")).toBeVisible();
    expect(screen.queryByText("No rows match.")).toBeNull();
  });
});

describe("leadingNumber", () => {
  it.each([
    ["$4,770.00", 4770],
    ["1,587,838", 1_587_838],
    ["-954.00", -954],
    ["3.2k", 3200],
    ["41.2 GB", 41.2],
    ["1.5M", 1_500_000],
    ["2B", 2_000_000_000],
    ["12%", 12],
    ["3 × $32.10", 3],
  ])("reads %s as %d", (text, n) => {
    expect(leadingNumber(text)).toBe(n);
  });

  it.each(["2026-10-01", "not recorded", ""])(
    "reads %j as no number (negative)",
    (text) => {
      expect(leadingNumber(text)).toBeNull();
    },
  );
});
