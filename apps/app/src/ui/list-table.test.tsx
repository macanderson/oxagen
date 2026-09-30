// @vitest-environment jsdom
// ListTable (list-table.tsx): the design's list controls over a table. Search
// narrows the rows to those whose rendered text holds the query; a small
// enumeration column offers a filter by the design's rule; a header
// sorts its column ascending, then descending, then back to the caller's
// order, as a number when the column is numeric; the pager under the table
// holds Rows, which sets the page size, the range, and Previous and Next,
// which walk the pages. A list that pages by address hands in its own pager
// (#4693), which the table draws in place of its own. A hidden column names
// itself through aria-label and carries no text. Every test ends in an axe
// check.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routes } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { optionNames, pickOption } from "@/test/select";
import { facetsOf, type ListRow, ListTable, leadingNumber } from "./list-table";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

// The address pager visits the first page at a new size through the router.
vi.mock("@/ui/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ui/navigation")>()),
  useNavigate: () => ({
    push,
    replace: vi.fn(),
    refresh: vi.fn(),
    advance: vi.fn(),
  }),
}));

beforeEach(() => {
  push.mockReset();
});

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

/** The pager's Previous and Next, named as a landmark. */
const pager = () => screen.getByRole("navigation", { name: "Invoices pages" });

/** The pager under the table: Rows, the range, then Previous and Next. */
const rowsPager = () => {
  const el = document.querySelector<HTMLElement>("[data-rows-pager]");
  if (el === null) throw new Error("the list has no pager");
  return el;
};

/** The bar over the table: the search box and the filters. */
const controls = () => {
  const el = document.querySelector<HTMLElement>("[data-list-controls]");
  if (el === null) throw new Error("the list has no control bar");
  return el;
};

/** The range the pager prints beside Rows ("1–10 of 12"). */
const range = () =>
  rowsPager().querySelector("[data-range]")?.textContent ?? null;

const rowsSelect = () =>
  within(rowsPager()).getByRole("combobox", { name: "Rows" });

const previousButton = () =>
  within(pager()).getByRole("button", { name: "Previous page" });

const nextButton = () =>
  within(pager()).getByRole("button", { name: "Next page" });

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("ListTable", () => {
  it("draws the search box, the table, and a pager with Rows at 10 and a 1–N of N range", () => {
    renderList(rowsOf(3));
    expect(
      screen.getByRole("searchbox", { name: "Search this list" }),
    ).toHaveAttribute("placeholder", "Search this list");
    expect(rowsSelect()).toHaveTextContent("10");
    expect(visible()).toEqual(["OXA-001", "OXA-002", "OXA-003"]);
    expect(range()).toBe("1–3 of 3");
    expect(previousButton()).toBeDisabled();
    expect(nextButton()).toBeDisabled();
  });

  it("puts Rows in the pager under the table, not in the bar over it", () => {
    renderList(rowsOf(3));
    const pagerEl = rowsPager();
    expect(
      within(pagerEl).getByRole("combobox", { name: "Rows" }),
    ).toBeInTheDocument();
    expect(
      within(controls()).queryByRole("combobox", { name: "Rows" }),
    ).toBeNull();
    expect(
      screen.getByRole("table").compareDocumentPosition(pagerEl) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    expect(range()).toBe("1–3 of 3");
    await userEvent.clear(search);
    await userEvent.type(search, "nothing here");
    expect(screen.getByText("No rows match.")).toBeInTheDocument();
    expect(range()).toBe("0 of 0");
    expect(previousButton()).toBeDisabled();
    expect(nextButton()).toBeDisabled();
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

  it("walks the pages with Next and Previous, each disabled at its end", async () => {
    renderList(rowsOf(12));
    expect(visible()).toHaveLength(10);
    expect(range()).toBe("1–10 of 12");
    expect(previousButton()).toBeDisabled();
    expect(nextButton()).toBeEnabled();
    await userEvent.click(nextButton());
    expect(visible()).toEqual(["OXA-011", "OXA-012"]);
    expect(range()).toBe("11–12 of 12");
    expect(nextButton()).toBeDisabled();
    expect(previousButton()).toBeEnabled();
    await userEvent.click(previousButton());
    expect(visible()).toHaveLength(10);
    expect(visible()[0]).toBe("OXA-001");
    expect(range()).toBe("1–10 of 12");
  });

  it("pages by the size chosen in Rows, from the first page", async () => {
    renderList(rowsOf(12));
    await userEvent.click(nextButton());
    expect(range()).toBe("11–12 of 12");
    await userEvent.click(rowsSelect());
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "5",
      "10",
      "25",
      "50",
      "All",
    ]);
    await userEvent.click(screen.getByRole("option", { name: "5" }));
    await waitFor(() => {
      expect(visible()).toHaveLength(5);
    });
    expect(rowsSelect()).toHaveTextContent("5");
    expect(range()).toBe("1–5 of 12");
    await userEvent.click(rowsSelect());
    await userEvent.click(await screen.findByRole("option", { name: "All" }));
    await waitFor(() => {
      expect(visible()).toHaveLength(12);
    });
    expect(rowsSelect()).toHaveTextContent("All");
    expect(range()).toBe("1–12 of 12");
    expect(nextButton()).toBeDisabled();
  });
});

describe("ListTable past the first screen", () => {
  it("keeps a row off the page in the document, hidden, so what it holds survives a page turn", async () => {
    renderList(rowsOf(12));
    await userEvent.click(nextButton());
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

  it("applies the current search to a row that arrives after it", async () => {
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
    // The new row is read as it mounts, so the query already in the box
    // applies to it.
    expect(visible()).toEqual(["OXA-001"]);
    await userEvent.clear(
      screen.getByRole("searchbox", { name: "Search this list" }),
    );
    expect(visible()).toEqual(["OXA-001", "OXA-002", "OXA-003", "LATE-1"]);
  });
});

describe("ListTable filters", () => {
  const STATUS_COLUMNS = [
    { label: "Invoice" },
    { label: "Currency" },
    { label: "Status" },
    { label: "Amount", numeric: true },
  ];
  const STATUSES = ["paid", "open", "paid", "void", "paid"];
  const statusRows = (): ListRow[] =>
    STATUSES.map((status, i) => ({
      key: `inv_${String(i)}`,
      cells: [
        `OXA-${String(i)}`,
        i === 0 ? "EUR" : "USD",
        <span key="s">{status}</span>,
        `$${String(i + 1)}.00`,
      ],
    }));

  function renderStatuses(rows: ListRow[]) {
    render(
      <IntlProvider>
        <ListTable label="Invoices" columns={STATUS_COLUMNS} rows={rows} />
      </IntlProvider>,
    );
  }

  it("offers none of its own when the caller draws its filters, so no column gets two (negative)", () => {
    render(
      <IntlProvider>
        <ListTable
          label="Invoices"
          columns={STATUS_COLUMNS}
          rows={statusRows()}
          filters={
            <select aria-label="Status">
              <option>All · Status</option>
            </select>
          }
        />
      </IntlProvider>,
    );
    expect(
      within(controls())
        .getAllByRole("combobox")
        .map((select) => select.getAttribute("aria-label")),
    ).toEqual(["Status"]);
  });

  it("offers a status-like column first, reads the values the cells show, and filters on one", async () => {
    const user = userEvent.setup();
    renderStatuses(statusRows());
    const filters = within(controls())
      .getAllByRole("combobox")
      .map((select) => select.getAttribute("aria-label"));
    // Status before Currency though Currency has fewer values; Invoice is one
    // value per row and Amount is a number, so neither offers a filter.
    expect(filters).toEqual(["Filter by Status", "Filter by Currency"]);
    const status = screen.getByRole("combobox", { name: "Filter by Status" });
    expect(await optionNames(user, status)).toEqual([
      "All · Status",
      "open",
      "paid",
      "void",
    ]);
    await pickOption(user, status, "paid");
    expect(visible()).toEqual(["OXA-0", "OXA-2", "OXA-4"]);
    expect(range()).toBe("1–3 of 3");
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Filter by Currency" }),
      "EUR",
    );
    expect(visible()).toEqual(["OXA-0"]);
    await pickOption(user, status, "All · Status");
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Filter by Currency" }),
      "All · Currency",
    );
    expect(visible()).toHaveLength(5);
  });

  it("offers no filter under four rows (negative)", () => {
    renderStatuses(statusRows().slice(0, 3));
    expect(screen.queryByRole("combobox", { name: /^Filter by/ })).toBeNull();
  });
});

describe("facetsOf", () => {
  const columns = [{ label: "Name" }, { label: "Health" }, { label: "Kind" }];

  it("refuses a column with one value, a value over 28 characters, or more than eight values (negative)", () => {
    const one = Array.from({ length: 5 }, (_, i) => [
      `n${String(i)}`,
      "not recorded",
      i === 0 ? "x".repeat(29) : "short",
    ]);
    expect(facetsOf(columns, one)).toEqual([]);
    const many = Array.from({ length: 10 }, (_, i) => [
      `n${String(i)}`,
      `h${String(i % 9)}`,
      "a",
    ]);
    expect(facetsOf(columns, many)).toEqual([]);
  });

  it("keeps three at most, status-like first, then fewer values", () => {
    const cols = [
      { label: "Owner" },
      { label: "Region" },
      { label: "Team" },
      { label: "Tier" },
    ];
    const texts = Array.from({ length: 8 }, (_, i) => [
      `o${String(i % 4)}`,
      `r${String(i % 3)}`,
      `t${String(i % 2)}`,
      `x${String(i % 5)}`,
    ]);
    expect(facetsOf(cols, texts).map((f) => cols[f.column]?.label)).toEqual([
      "Tier",
      "Team",
      "Region",
    ]);
  });

  it("offers nothing on a numeric, a hidden or an unlabelled column, however few values it holds (negative)", () => {
    // Each column repeats two values over six rows, which the rule would
    // otherwise offer, so only the column's kind can refuse it.
    const cols = [
      { label: "Amount", numeric: true },
      { label: "Status", hidden: true },
      { label: " " },
      { label: "Health" },
    ];
    const texts = Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 4 }, () => (i % 2 === 0 ? "1" : "2")),
    );
    expect(facetsOf(cols, texts)).toEqual([{ column: 3, values: ["1", "2"] }]);
  });

  it("skips a blank cell rather than offering it as a value, and still offers the column", () => {
    const texts = [
      ["a", "", "k"],
      ["b", "degraded", "k"],
      ["c", "", "k"],
      ["d", "healthy", "k"],
      ["e", "healthy", "k"],
    ];
    expect(facetsOf(columns, texts)).toEqual([
      { column: 1, values: ["degraded", "healthy"] },
    ]);
  });

  it("refuses a column with a value on every row, even under eight values (negative)", () => {
    const texts = Array.from({ length: 5 }, (_, i) => [
      "n",
      `h${String(i)}`,
      i < 3 ? "a" : "b",
    ]);
    expect(facetsOf(columns, texts)).toEqual([
      { column: 2, values: ["a", "b"] },
    ]);
  });
});

describe("ListTable: a caller's filters and empty line", () => {
  it("draws the caller's filters after the search box, and Rows in the pager under the table", () => {
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
    const status = within(controls()).getByRole("combobox", { name: "Status" });
    expect(
      search.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("table").compareDocumentPosition(rowsSelect()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
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

describe("ListTable with a pager that pages by address", () => {
  /** The invoices' pager on a middle page at 25 rows, as the server builds it. */
  const PAGER = {
    label: "Invoice pages",
    rowsLabel: "Rows",
    previousLabel: "Newest invoices",
    nextLabel: "Older invoices",
    perPage: 25,
    sizes: [10, 25, 50, 100].map((size) => ({
      size,
      first: routes.billing(
        "acme",
        size === 50 ? {} : { rows: String(size) },
      ),
    })),
    previous: routes.billing("acme", { rows: "25" }),
    next: routes.billing("acme", { rows: "25", cursor: "c3" }),
  };

  function renderPaged(rows: ListRow[]) {
    render(
      <IntlProvider>
        <ListTable
          label="Invoices"
          columns={COLUMNS}
          rows={rows}
          pager={PAGER}
        />
      </IntlProvider>,
    );
  }

  const pages = () =>
    screen.getByRole("navigation", { name: "Invoice pages" });

  it("draws the caller's pager in place of its own, under the table, and shows every row it was handed", () => {
    renderPaged(rowsOf(12));
    expect(
      screen.queryByRole("navigation", { name: "Invoices pages" }),
    ).toBeNull();
    expect(visible()).toHaveLength(12);
    expect(range()).toBe("1–12 of 12");
    expect(rowsSelect()).toHaveTextContent("25");
    expect(
      screen.getByRole("table").compareDocumentPosition(rowsPager()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(pages()).getByRole("link", { name: "Newest invoices" }),
    ).toHaveAttribute("href", "/acme/billing?rows=25");
    expect(
      within(pages()).getByRole("link", { name: "Older invoices" }),
    ).toHaveAttribute("href", "/acme/billing?rows=25&cursor=c3");
  });

  it("offers the caller's sizes and visits the first page at the size picked", async () => {
    renderPaged(rowsOf(3));
    await userEvent.click(rowsSelect());
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "10",
      "25",
      "50",
      "100",
    ]);
    await userEvent.click(screen.getByRole("option", { name: "50" }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/acme/billing");
    });
  });

  it("counts in its range the rows the search keeps", async () => {
    renderPaged(rowsOf(12));
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "oxa-01",
    );
    expect(visible()).toEqual(["OXA-010", "OXA-011", "OXA-012"]);
    expect(range()).toBe("1–3 of 3");
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
