// @vitest-environment jsdom
// The Organization list (list-table.tsx) over the shared list table: the
// "All · Status" filters sit in the control row between the search box and
// Rows, a filter narrows the rows before the shared table pages them, Rows
// offers 5, 10, 25, 50 and All, the pager is numbered, the row actions column
// has no header text, and a list with no rows prints the section's own line.
// A filter the record cannot back is drawn disabled with its reason. Checked
// with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { type ListRow, ListTable } from "./list-table";

afterEach(cleanup);

const rows: ListRow[] = Array.from({ length: 12 }, (_, index) => ({
  key: `row-${String(index)}`,
  rowId: `row-${String(index)}`,
  values: { status: index % 2 === 0 ? "active" : "invited" },
  cells: [
    <span key="name">
      {index === 3 ? "Marcus Bell" : `Person ${String(index)}`}
    </span>,
    <span key="n">{index}</span>,
    <button key="open" type="button">
      Open
    </button>,
  ],
}));

function renderList(
  list: readonly ListRow[] = rows,
  empty = "No person matches this search.",
) {
  return render(
    <IntlProvider>
      <ListTable
        label="People"
        columns={[
          { label: "Person" },
          { label: "Number", numeric: true },
          { label: "Actions", hidden: true },
        ]}
        rows={list}
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { value: "active", label: "active" },
              { value: "invited", label: "invited" },
            ],
          },
          {
            key: "twoFactor",
            label: "Two-factor",
            options: [{ value: "totp", label: "TOTP" }],
            unrecorded: "No contract records a member's two-factor method.",
          },
        ]}
        empty={empty}
      />
    </IntlProvider>,
  );
}

/** The rows a reader sees: the shared table hides the rows off the page. */
function shownRows() {
  return within(screen.getByRole("table", { name: "People" }))
    .getAllByRole("row")
    .slice(1)
    .filter(
      (tr) =>
        tr.style.display !== "none" && !tr.hasAttribute("data-list-empty"),
    );
}

const pager = () => screen.getByRole("navigation", { name: "People pages" });

describe("ListTable", () => {
  it("shows the first ten rows under a numbered pager", async () => {
    const view = renderList();
    expect(shownRows()).toHaveLength(10);
    expect(pager()).toHaveTextContent("1–10 of 12");
    expect(within(pager()).getByRole("button", { name: "1" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(pager()).getByRole("button", { name: "2" }),
    ).toBeInTheDocument();
    await expectNoAxe(view.container);
  });

  it("offers the design's Rows choices, All included", async () => {
    const user = userEvent.setup();
    renderList();
    const size = screen.getByLabelText("Rows");
    expect(
      within(size)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["5", "10", "25", "50", "All"]);
    await user.selectOptions(size, "0");
    expect(shownRows()).toHaveLength(12);
    expect(pager()).toHaveTextContent("1–12 of 12");
  });

  it("draws the filters between the search box and Rows, labelled All · Status", () => {
    renderList();
    const status = screen.getByLabelText("Status");
    expect(within(status).getAllByRole("option")[0]).toHaveTextContent(
      "All · Status",
    );
    const search = screen.getByRole("searchbox");
    const size = screen.getByLabelText("Rows");
    expect(
      search.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      status.compareDocumentPosition(size) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("narrows the rows by a filter before the pager counts them", async () => {
    const user = userEvent.setup();
    renderList();
    await user.selectOptions(screen.getByLabelText("Status"), "invited");
    expect(shownRows()).toHaveLength(6);
    expect(pager()).toHaveTextContent("1–6 of 6");
    for (const row of shownRows()) {
      expect(Number(row.getAttribute("data-row")?.slice(4)) % 2).toBe(1);
    }
  });

  it("keeps each row's data-row for the tests and the styles", () => {
    renderList();
    expect(document.querySelector('[data-row="row-3"]')).toHaveTextContent(
      "Marcus Bell",
    );
  });

  it("draws the row actions column with no header text and an accessible name", () => {
    renderList();
    const headers = within(
      screen.getByRole("table", { name: "People" }),
    ).getAllByRole("columnheader");
    const actions = headers[2];
    expect(actions).toHaveAccessibleName("Actions");
    expect(actions?.textContent).toBe("");
  });

  it("draws a filter the record cannot back disabled, with its reason (negative)", () => {
    renderList();
    const twoFactor = screen.getByLabelText("Two-factor");
    expect(twoFactor).toBeDisabled();
    expect(twoFactor).toHaveAccessibleDescription(
      "No contract records a member's two-factor method.",
    );
  });

  it("prints the section's own line when there are no rows (negative)", async () => {
    const view = renderList([], "This organization has no members.");
    expect(screen.getByText("This organization has no members.")).toBeVisible();
    expect(pager()).toHaveTextContent("0 of 0");
    await expectNoAxe(view.container);
  });
});
