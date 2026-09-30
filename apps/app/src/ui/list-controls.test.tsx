// @vitest-environment jsdom
// The four list controls: search narrows, a filter narrows, a sort reorders,
// Rows per page, under the rows, pages, and the pager steps and stops at each
// end.
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
import { pickOption } from "@/test/select";
import {
  ListBar,
  type ListFilter,
  ListPager,
  type ListSort,
  useList,
} from "./list-controls";

type Row = { name: string; role: string };

const ROWS: Row[] = Array.from({ length: 30 }, (_, i) => ({
  name: `repo-${String(i + 1).padStart(2, "0")}`,
  role: i === 0 ? "main" : "linked",
}));

const SORTS: ListSort<Row>[] = [
  { value: "shown", label: "Shown order", compare: null },
  {
    value: "za",
    label: "Name Z–A",
    compare: (a, b) => b.name.localeCompare(a.name),
  },
];

const FILTERS: ListFilter<Row>[] = [
  {
    key: "role",
    label: "Role",
    options: [
      { value: "main", label: "main" },
      { value: "linked", label: "linked" },
    ],
    get: (row) => row.role,
  },
];

function Harness() {
  const list = useList(ROWS, {
    text: (row) => row.name,
    sorts: SORTS,
    filters: FILTERS,
  });
  return (
    <div>
      <ListBar
        list={list}
        searchLabel="Search this list"
        sortLabel="Sort"
        sorts={SORTS}
        filters={FILTERS}
        allLabel={(column) => `All · ${column}`}
      />
      <ul data-testid="rows">
        {list.shown.map((row) => (
          <li key={row.name}>{row.name}</li>
        ))}
      </ul>
      <ListPager
        list={list}
        label="Pages"
        rowsLabel="Rows per page"
        range={(from, to, total) =>
          `${String(from)}–${String(to)} of ${String(total)}`
        }
        previousLabel="Previous page"
        nextLabel="Next page"
      />
    </div>
  );
}

const shown = () =>
  within(screen.getByTestId("rows"))
    .queryAllByRole("listitem")
    .map((li) => li.textContent);

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the list controls", () => {
  it("shows 25 rows and the range, and pages to the rest", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(shown()).toHaveLength(25);
    expect(screen.getByText("1–25 of 30")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Previous page" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(shown()).toEqual([
      "repo-26",
      "repo-27",
      "repo-28",
      "repo-29",
      "repo-30",
    ]);
    expect(screen.getByText("26–30 of 30")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Next page" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("searches, filters and sorts, and returns to the first page", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await user.type(screen.getByLabelText("Search this list"), "repo-3");
    expect(shown()).toEqual(["repo-30"]);
    await user.clear(screen.getByLabelText("Search this list"));
    const role = screen.getByRole("combobox", { name: "All · Role" });
    await pickOption(user, role, "main");
    expect(shown()).toEqual(["repo-01"]);
    await pickOption(user, role, "All · Role");
    await pickOption(
      user,
      screen.getByRole("combobox", { name: "Sort" }),
      "Name Z–A",
    );
    expect(shown()[0]).toBe("repo-30");
  });

  it("puts Rows per page in the pager, not the bar", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const bar = container.querySelector<HTMLElement>("[data-list-bar]");
    if (bar === null) throw new Error("the list has no bar");
    expect(
      within(bar).queryByRole("combobox", { name: "Rows per page" }),
    ).toBeNull();
    const pager = container.querySelector<HTMLElement>("[data-rows-pager]");
    if (pager === null) throw new Error("the list has no pager");
    const rows = within(pager).getByRole("combobox", {
      name: "Rows per page",
    });
    expect(rows.textContent).toContain("25");
    await user.click(rows);
    await user.click(await screen.findByRole("option", { name: "10" }));
    await waitFor(() => {
      expect(shown()).toHaveLength(10);
    });
    expect(screen.getByText("1–10 of 30")).toBeDefined();
  });

  it("reads 0–0 of 0 when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Search this list"), "nothing");
    expect(shown()).toHaveLength(0);
    expect(screen.getByText("0–0 of 0")).toBeDefined();
  });
});
