// @vitest-environment jsdom
// ListTable (faceted-list-table.tsx): the Steering library's list tools. The
// bar keeps the search and every select on one wrapping row: no control
// carries `w-full`, which stacked each filter onto a line of its own. Search,
// a column filter, a header sort and the pager each narrow or order the rows
// in the browser. Every test ends in an axe check.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { type ListRow, ListTable, pageNumbers } from "./faceted-list-table";

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

afterEach(cleanup);

describe("faceted ListTable", () => {
  it("lays the bar out as one wrapping row of content-sized controls", async () => {
    const { container } = renderList(rowsOf(3));
    const bar = container.querySelector("[data-list-tools]");
    expect(bar).not.toBeNull();
    const controls = [
      ...(bar?.querySelectorAll("input, select") ?? []),
    ] as HTMLElement[];
    expect(controls).toHaveLength(3);
    for (const control of controls) {
      expect(control.className).not.toMatch(/\bw-full\b/);
      expect(control.className).not.toMatch(/\bblock\b/);
    }
    expect(screen.getByRole("searchbox").className).toContain(
      "flex-[1_1_14rem]",
    );
    for (const select of screen.getAllByRole("combobox")) {
      expect(select.className).toContain("appearance-none");
      expect(select.parentElement?.className).toContain("shrink-0");
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

    const scope = container.querySelector<HTMLSelectElement>(
      '[data-filter="scope"]',
    );
    expect(scope).not.toBeNull();
    if (scope !== null) await user.selectOptions(scope, "org");
    expect(bodyRows()).toHaveLength(6);
    if (scope !== null) await user.selectOptions(scope, "");

    await user.click(screen.getByRole("button", { name: "Tokens" }));
    expect(bodyRows()[0]).toHaveTextContent("Record 12");

    const rows = container.querySelector<HTMLSelectElement>("[data-rows]");
    if (rows !== null) await user.selectOptions(rows, "5");
    expect(bodyRows()).toHaveLength(5);
    await expectNoAxe(container);
  });

  it("draws every page number to seven, then the ends and the neighbours", () => {
    expect(pageNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(pageNumbers(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
  });
});
