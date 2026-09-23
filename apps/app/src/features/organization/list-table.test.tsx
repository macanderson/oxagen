// @vitest-environment jsdom
// The Organization list: the search box and the select filters narrow the
// rows, Rows sets the page size, the pager reads "1–10 of N" and pages, and a
// search that matches nothing prints the section's own line in place of the
// table. Checked with axe.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { ListTable, type ListRow } from "./list-table";

afterEach(cleanup);

const rows: ListRow[] = Array.from({ length: 12 }, (_, index) => ({
  key: `row-${String(index)}`,
  rowId: `row-${String(index)}`,
  search: index === 3 ? "Marcus Bell owner" : `Person ${String(index)}`,
  values: { status: index % 2 === 0 ? "active" : "invited" },
  cells: [
    <span key="name">
      {index === 3 ? "Marcus Bell" : `Person ${String(index)}`}
    </span>,
    <span key="n">{index}</span>,
  ],
}));

function renderList() {
  return render(
    <IntlProvider>
      <ListTable
        label="People"
        columns={[{ label: "Person" }, { label: "Number", numeric: true }]}
        rows={rows}
        filters={[
          {
            key: "status",
            label: "Status",
            options: [
              { value: "active", label: "active" },
              { value: "invited", label: "invited" },
            ],
          },
        ]}
        empty="No person matches this search."
      />
    </IntlProvider>,
  );
}

function bodyRows() {
  return (
    within(screen.getByRole("table", { name: "People" })).getAllByRole("row")
      .length - 1
  );
}

describe("ListTable", () => {
  it("shows the first ten rows and the range they cover", async () => {
    const view = renderList();
    expect(bodyRows()).toBe(10);
    expect(screen.getByTestId("list-range")).toHaveTextContent("1–10 of 12");
    expect(screen.getByRole("columnheader", { name: "Number" })).toHaveClass(
      "text-right",
    );
    await expectNoAxe(view.container);
  });

  it("pages forward and back", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(bodyRows()).toBe(2);
    expect(screen.getByTestId("list-range")).toHaveTextContent("11–12 of 12");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByTestId("list-range")).toHaveTextContent("1–10 of 12");
  });

  it("widens the page with Rows and drops the pager", async () => {
    renderList();
    await userEvent.selectOptions(screen.getByLabelText("Rows"), "25");
    expect(bodyRows()).toBe(12);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  });

  it("narrows by a filter whose first choice reads All", async () => {
    renderList();
    const status = screen.getByLabelText("Status");
    expect(
      within(status).getByRole("option", { name: "All · Status" }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(status, "invited");
    expect(screen.getByTestId("list-range")).toHaveTextContent("1–6 of 6");
  });

  it("draws a filter the record cannot answer disabled, with the reason as its description (negative)", () => {
    render(
      <IntlProvider>
        <ListTable
          label="People"
          columns={[{ label: "Person" }, { label: "Number", numeric: true }]}
          rows={rows}
          filters={[
            {
              key: "twoFactor",
              label: "Two-factor",
              options: [{ value: "totp", label: "TOTP" }],
              unrecorded: "No contract records it yet.",
            },
          ]}
          empty="No person matches this search."
        />
      </IntlProvider>,
    );
    const filter = screen.getByLabelText("Two-factor");
    expect(filter).toBeDisabled();
    expect(filter).toHaveAccessibleDescription("No contract records it yet.");
    expect(filter).toHaveAttribute("data-not-recorded");
    expect(screen.getByTestId("list-range")).toHaveTextContent("1–10 of 12");
  });

  it("searches the text each row carries, from the first page", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "marcus",
    );
    expect(bodyRows()).toBe(1);
    expect(screen.getByText("Marcus Bell")).toBeInTheDocument();
    expect(screen.getByTestId("list-range")).toHaveTextContent("1–1 of 1");
  });

  it("says what the section says when nothing matches, and draws no table", async () => {
    const view = renderList();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search this list" }),
      "nobody at all",
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByText("No person matches this search."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("list-range")).toHaveTextContent("0–0 of 0");
    await expectNoAxe(view.container);
  });
});
