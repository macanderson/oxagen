// @vitest-environment jsdom
// The four list controls: search narrows, a filter narrows, a sort reorders,
// Rows pages, and the pager steps and stops at each end.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import {
  ListBar,
  type ListFilter,
  ListPager,
  type ListSort,
  useList,
} from "./list-controls";

type Row = { name: string; role: string };

const ROWS: Row[] = Array.from({ length: 12 }, (_, i) => ({
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
        rowsLabel="Rows"
      />
      <ul>
        {list.shown.map((row) => (
          <li key={row.name}>{row.name}</li>
        ))}
      </ul>
      <ListPager
        list={list}
        range={(from, to, total) =>
          `${String(from)}–${String(to)} of ${String(total)}`
        }
        previousLabel="Previous page"
        nextLabel="Next page"
      />
    </div>
  );
}

const shown = () => screen.getAllByRole("listitem").map((li) => li.textContent);

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the list controls", () => {
  it("shows ten rows and the range, and pages to the rest", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(shown()).toHaveLength(10);
    expect(screen.getByText("1–10 of 12")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: "Previous page" })
        .hasAttribute("disabled"),
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(shown()).toEqual(["repo-11", "repo-12"]);
    expect(screen.getByText("11–12 of 12")).toBeDefined();
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
    await user.type(screen.getByLabelText("Search this list"), "repo-1");
    expect(shown()).toEqual(["repo-10", "repo-11", "repo-12"]);
    await user.clear(screen.getByLabelText("Search this list"));
    await user.selectOptions(screen.getByLabelText("All · Role"), "main");
    expect(shown()).toEqual(["repo-01"]);
    await user.selectOptions(screen.getByLabelText("All · Role"), "");
    await user.selectOptions(screen.getByLabelText("Sort"), "za");
    expect(shown()[0]).toBe("repo-12");
  });

  it("widens the page with Rows", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.selectOptions(screen.getByLabelText("Rows"), "25");
    expect(shown()).toHaveLength(12);
    expect(screen.getByText("1–12 of 12")).toBeDefined();
  });

  it("reads 0–0 of 0 when nothing matches", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByLabelText("Search this list"), "nothing");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("0–0 of 0")).toBeDefined();
  });
});
