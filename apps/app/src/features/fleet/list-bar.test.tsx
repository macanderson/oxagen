// @vitest-environment jsdom
// The Runs panel's list controls (#3837): the search, the Status, Tier and
// Replay facets from the closed vocabularies, each change handed on as the
// next list query (a navigation), never applied to the rows of one page.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { RunsListBar, SEARCH_PAUSE_MS } from "./list-bar";
import { DEFAULT_LIST_QUERY, type FleetListQuery } from "./list-query";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const list = (over: Partial<FleetListQuery> = {}): FleetListQuery => ({
  ...DEFAULT_LIST_QUERY,
  ...over,
});

function renderBar(props: Partial<Parameters<typeof RunsListBar>[0]> = {}): {
  onList: ReturnType<typeof vi.fn>;
  rerender: (q: FleetListQuery) => void;
} {
  const onList = vi.fn();
  const base = {
    list: list(),
    onList,
    pageSize: 25 as const,
    onPageSize: vi.fn(),
    pullRequests: "any" as const,
    onPullRequests: vi.fn(),
    onColumns: vi.fn(),
    ...props,
  };
  const view = render(
    <IntlProvider>
      <RunsListBar {...base} />
    </IntlProvider>,
  );
  return {
    onList,
    rerender: (next) => {
      view.rerender(
        <IntlProvider>
          <RunsListBar {...base} list={next} />
        </IntlProvider>,
      );
    },
  };
}

const options = (testId: string) =>
  within(screen.getByTestId(testId))
    .getAllByRole("option")
    .map((option) => option.textContent);

describe("RunsListBar", () => {
  it("offers each facet's closed vocabulary, whatever the page holds", async () => {
    const { container } = render(
      <IntlProvider>
        <RunsListBar
          list={list()}
          onList={vi.fn()}
          pageSize={25}
          onPageSize={vi.fn()}
          pullRequests="any"
          onPullRequests={vi.fn()}
          onColumns={vi.fn()}
        />
      </IntlProvider>,
    );
    expect(options("facet-tier")).toEqual([
      "All · Tier",
      "contained",
      "gateway",
      "harness",
      "observe",
    ]);
    expect(options("facet-status")).toEqual([
      "All · Status",
      "live",
      "sealed",
      "halted",
    ]);
    expect(options("facet-replay")).toHaveLength(6);
    expect(options("facet-replay").at(-1)).toBe("not recorded");
    await expectNoAxe(container);
  });

  it("hands on a facet choice as a new list from page 1", async () => {
    const { onList } = renderBar({ list: list({ page: 4 }) });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId("facet-tier"), "gateway");
    expect(onList).toHaveBeenLastCalledWith(
      list({ tier: ["gateway"], page: 1 }),
    );
    await user.selectOptions(screen.getByTestId("facet-status"), "halted");
    expect(onList).toHaveBeenLastCalledWith(
      list({ status: ["halted"], page: 1 }),
    );
  });

  it("clears a facet with its All option", async () => {
    const { onList } = renderBar({ list: list({ replay: ["fork"] }) });
    expect(screen.getByTestId("facet-replay")).toHaveValue("fork");
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId("facet-replay"), "");
    expect(onList).toHaveBeenLastCalledWith(list({ replay: [] }));
  });

  it("shows a URL's several words for one facet as one choice", () => {
    renderBar({ list: list({ status: ["live", "halted"] }) });
    expect(screen.getByTestId("facet-status")).toHaveValue("live,halted");
    expect(options("facet-status")[1]).toBe("live, halted");
  });

  it("sends the search once typing pauses, trimmed, and not on every key", () => {
    vi.useFakeTimers();
    const { onList } = renderBar({ list: list({ page: 2 }) });
    const box = screen.getByTestId("runs-search");
    fireEvent.change(box, { target: { value: " dep" } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_PAUSE_MS - 1);
    });
    fireEvent.change(box, { target: { value: " deploy " } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_PAUSE_MS - 1);
    });
    expect(onList).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onList).toHaveBeenCalledOnce();
    expect(onList).toHaveBeenLastCalledWith(list({ q: "deploy", page: 1 }));
  });

  it("sends the search at once on Enter, and only once", async () => {
    const { onList } = renderBar();
    const user = userEvent.setup();
    await user.type(screen.getByTestId("runs-search"), "arun_07{Enter}");
    expect(onList).toHaveBeenCalledWith(list({ q: "arun_07" }));
    await new Promise((resolve) => setTimeout(resolve, SEARCH_PAUSE_MS + 50));
    expect(onList).toHaveBeenCalledOnce();
  });

  it("takes the URL's search back when the URL changed to something it did not send", () => {
    const { rerender } = renderBar({ list: list({ q: "deploy" }) });
    expect(screen.getByTestId("runs-search")).toHaveValue("deploy");
    rerender(list({ q: "" }));
    expect(screen.getByTestId("runs-search")).toHaveValue("");
  });

  it("labels the search as searching every run", () => {
    renderBar();
    expect(
      screen.getByRole("searchbox", { name: "Search runs" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("search", { name: "Search runs" }),
    ).toBeInTheDocument();
  });
});
