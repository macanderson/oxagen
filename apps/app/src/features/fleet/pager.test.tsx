// @vitest-environment jsdom
// The Runs pager (#3837): "from–to of total" from the read's count, page
// buttons to the last page, the bound with a plus sign past the count, and
// the cursor links when the read did not count.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { DEFAULT_LIST_QUERY, type FleetListQuery } from "./list-query";
import { pageButtons, RunsPager } from "./pager";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(cleanup);

const list = (over: Partial<FleetListQuery> = {}): FleetListQuery => ({
  ...DEFAULT_LIST_QUERY,
  ...over,
});

function renderPager(props: Partial<Parameters<typeof RunsPager>[0]> = {}) {
  return render(
    <IntlProvider>
      <RunsPager
        list={list()}
        pageSize={10}
        rows={10}
        cursor={null}
        nextCursor={null}
        pullRequests="any"
        org="acme"
        ws="core"
        {...props}
      />
    </IntlProvider>,
  );
}

const pageLinks = () =>
  within(screen.getByTestId("pager-pages"))
    .getAllByRole("link")
    .map((link) => [link.textContent, link.getAttribute("href")]);

describe("pageButtons", () => {
  it("draws the first, the neighbours of the current and the last page, with gaps", () => {
    expect(pageButtons(5, 28, true)).toEqual([
      { page: 1 },
      { gapAfter: 1 },
      { page: 4 },
      { page: 5 },
      { page: 6 },
      { gapAfter: 6 },
      { page: 28 },
    ]);
    expect(pageButtons(1, 3, true)).toEqual([
      { page: 1 },
      { page: 2 },
      { page: 3 },
    ]);
  });

  it("ends in a gap when the last page is not known", () => {
    expect(pageButtons(2, 1001, false)).toEqual([
      { page: 1 },
      { page: 2 },
      { page: 3 },
      { gapAfter: 3 },
    ]);
  });
});

describe("RunsPager", () => {
  it("reads from–to of the total and offers every page to the last", async () => {
    const { container } = renderPager({ total: 279, totalBound: 10_000 });
    expect(screen.getByTestId("pager-range")).toHaveTextContent("1–10 of 279");
    expect(screen.getByTestId("pager-current")).toHaveTextContent("1");
    expect(screen.getByTestId("pager-current")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(pageLinks()).toEqual([
      ["2", "/acme/core?page=2"],
      ["28", "/acme/core?page=28"],
      ["Next", "/acme/core?page=2"],
    ]);
    await expectNoAxe(container);
  });

  it("numbers a later page from its offset and keeps the list on every link", () => {
    renderPager({
      list: list({ page: 28, q: "deploy", sort: "cost", dir: "asc" }),
      rows: 9,
      total: 279,
      totalBound: 10_000,
    });
    expect(screen.getByTestId("pager-range")).toHaveTextContent(
      "271–279 of 279",
    );
    const links = pageLinks();
    expect(links[0]).toEqual([
      "Previous",
      "/acme/core?q=deploy&sort=cost&dir=asc&page=27",
    ]);
    expect(links.map(([text]) => text)).not.toContain("Next");
  });

  it("reads the bound with a plus sign when more runs match than the count reaches", () => {
    renderPager({
      list: list({ page: 2 }),
      total: null,
      totalBound: 10_000,
    });
    expect(screen.getByTestId("pager-range")).toHaveTextContent(
      "11–20 of 10,000+",
    );
    expect(pageLinks().map(([text]) => text)).toEqual([
      "Previous",
      "1",
      "3",
      "Next",
    ]);
  });

  it("says a page past the end holds none of the total", () => {
    renderPager({ list: list({ page: 40 }), rows: 0, total: 279 });
    expect(screen.getByTestId("pager-range")).toHaveTextContent("0 of 279");
  });

  it("keeps the plus sign on an empty page past the count's bound", () => {
    renderPager({
      list: list({ page: 402 }),
      rows: 0,
      total: null,
      totalBound: 10_000,
    });
    expect(screen.getByTestId("pager-range")).toHaveTextContent("0 of 10,000+");
  });

  it("reads 0 of 0 for an empty list", () => {
    renderPager({ rows: 0, total: 0, totalBound: 10_000 });
    expect(screen.getByTestId("pager-range")).toHaveTextContent("0 of 0");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("falls back to the cursor when the read did not count", async () => {
    const { container } = renderPager({
      rows: 10,
      cursor: "c1",
      nextCursor: "c2",
      pullRequests: "with",
      list: list({ status: ["sealed"] }),
    });
    // No count, so no position and no total: nothing counted "10+".
    expect(screen.getByTestId("pager-range")).toHaveTextContent(
      "10 runs on this page",
    );
    expect(screen.getByRole("link", { name: "Newest runs" })).toHaveAttribute(
      "href",
      "/acme/core?prs=with",
    );
    expect(screen.getByRole("link", { name: "Older runs" })).toHaveAttribute(
      "href",
      "/acme/core?prs=with&status=sealed&cursor=c2",
    );
    expect(screen.queryByTestId("pager-pages")).toBeNull();
    await expectNoAxe(container);
  });
});
