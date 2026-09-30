// @vitest-environment jsdom
// ListTable (faceted-list-table.tsx): the Steering library's list tools. The
// bar keeps the search and every filter on one wrapping row: no control
// carries `w-full`, which stacked each filter onto a line of its own. Rows
// sits in the pager under the table, beside the range and the Previous and
// Next steps. Search, a column filter, a header sort and the pager each
// narrow or order the rows in the browser. Every test ends in an axe check.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { pickOption } from "@/test/select";
import { type ListRow, ListTable } from "./faceted-list-table";

const COLUMNS = [
  { key: "item", label: "Item" },
  { key: "scope", label: "Scope" },
  { key: "tokens", label: "Tokens", numeric: true },
];

const rowsOf = (n: number): ListRow[] =>
  Array.from({ length: n }, (_, i) => {
    const item = `Record ${String(i + 1)}`;
    const scope = i % 2 === 0 ? "workspace" : "org";
    const tokens = (n - i) * 10;
    return {
      key: item,
      values: { item, scope, tokens },
      node: (
        <tr key={item}>
          <td>{item}</td>
          <td>{scope}</td>
          <td>{tokens}</td>
        </tr>
      ),
    };
  });

function renderList(rows: ListRow[]) {
  return render(
    <IntlProvider>
      <ListTable
        label="Library"
        columns={COLUMNS}
        rows={rows}
        filters={["scope"]}
      />
    </IntlProvider>,
  );
}

const bodyRows = () =>
  within(screen.getByRole("table")).getAllByRole("row").slice(1);

/** The pager under the table: Rows and the range, then Previous and Next. */
function pagerOf(container: HTMLElement): HTMLElement {
  const pager = container.querySelector<HTMLElement>("[data-rows-pager]");
  if (pager === null) throw new Error("the list has no pager");
  return pager;
}

afterEach(cleanup);

describe("faceted ListTable", () => {
  it("lays the bar out as one wrapping row of content-sized controls", async () => {
    const { container } = renderList(rowsOf(3));
    const bar = container.querySelector<HTMLElement>("[data-list-tools]");
    if (bar === null) throw new Error("the list has no tool bar");
    // The search and the one filter; Rows is in the pager, not the bar.
    const search = within(bar).getByRole("searchbox");
    const filters = within(bar).getAllByRole("combobox");
    expect(filters).toHaveLength(1);
    for (const control of [search, ...filters]) {
      expect(control.className).not.toMatch(/\bw-full\b/);
      expect(control.className).not.toMatch(/\bblock\b/);
    }
    expect(search.className).toContain("flex-[1_1_14rem]");
    // Each filter is the app's Select, and it keeps its width in the row.
    for (const filter of filters) {
      expect(filter).toHaveAttribute("data-slot", "select-trigger");
      expect(filter.className).toContain("shrink-0");
    }
    await expectNoAxe(container);
  });

  it("searches, filters, sorts and pages the rows", async () => {
    const user = userEvent.setup();
    const { container } = renderList(rowsOf(12));
    expect(bodyRows()).toHaveLength(10);

    await user.type(screen.getByRole("searchbox"), "Record 1");
    // Record 1, 10, 11 and 12.
    expect(bodyRows()).toHaveLength(4);
    await user.clear(screen.getByRole("searchbox"));

    const scope = screen.getByRole("combobox", { name: "Filter by Scope" });
    await pickOption(user, scope, "org");
    expect(bodyRows()).toHaveLength(6);
    await pickOption(user, scope, "All (Scope)");

    await user.click(screen.getByRole("button", { name: "Tokens" }));
    expect(bodyRows()[0]).toHaveTextContent("Record 12");

    const pager = pagerOf(container);
    await user.click(within(pager).getByRole("combobox", { name: "Rows" }));
    await user.click(await screen.findByRole("option", { name: "5" }));
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(5);
    });
    expect(
      within(pager).getByRole("combobox", { name: "Rows" }),
    ).toHaveTextContent("5");
    await user.click(within(pager).getByRole("button", { name: "Next page" }));
    expect(bodyRows()).toHaveLength(5);
    expect(pager.querySelector("[data-range]")).toHaveTextContent("6–10 of 12");
    await expectNoAxe(container);
  });

  it("draws Rows in the pager under the table, and steps a page at a time", async () => {
    const user = userEvent.setup();
    const { container } = renderList(rowsOf(12));
    const pager = pagerOf(container);
    expect(
      screen.getByRole("table").compareDocumentPosition(pager) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const rows = within(pager).getByRole("combobox", { name: "Rows" });
    expect(rows).toHaveTextContent("10");
    const range = () => pager.querySelector("[data-range]");
    const step = (name: string) =>
      within(pager).getByRole("button", { name: `${name} page` });
    // The range sits beside Rows, outside the Pages landmark.
    expect(
      within(pager).getByRole("navigation", { name: "Pages" }),
    ).not.toHaveTextContent("of 12");

    expect(range()).toHaveTextContent("1–10 of 12");
    expect(step("Previous")).toBeDisabled();
    await user.click(step("Next"));
    expect(range()).toHaveTextContent("11–12 of 12");
    expect(bodyRows()).toHaveLength(2);
    expect(bodyRows()[0]).toHaveTextContent("Record 11");
    expect(step("Next")).toBeDisabled();
    await user.click(step("Previous"));
    expect(range()).toHaveTextContent("1–10 of 12");
    expect(bodyRows()[0]).toHaveTextContent("Record 1");

    // All is every row on one page, so neither step has a page to turn to.
    await user.click(rows);
    await user.click(await screen.findByRole("option", { name: "All" }));
    await waitFor(() => {
      expect(bodyRows()).toHaveLength(12);
    });
    expect(rows).toHaveTextContent("All");
    expect(range()).toHaveTextContent("1–12 of 12");
    expect(step("Previous")).toBeDisabled();
    expect(step("Next")).toBeDisabled();
    await expectNoAxe(container);
  });

  it("reads 0 of 0 with both steps disabled when nothing matches", async () => {
    const user = userEvent.setup();
    const { container } = renderList(rowsOf(12));
    await user.type(screen.getByRole("searchbox"), "nothing like it");
    expect(screen.getByText("No rows match.")).toBeVisible();
    const pager = pagerOf(container);
    expect(pager.querySelector("[data-range]")).toHaveTextContent("0 of 0");
    expect(
      within(pager).getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    expect(
      within(pager).getByRole("button", { name: "Next page" }),
    ).toBeDisabled();
    await expectNoAxe(container);
  });
});
