// @vitest-environment jsdom
/**
 * mention-menu.test.tsx
 *
 * Unit tests for MentionMenu — the two-stage presentational picker overlay.
 * The composer owns query/active-index/keyboard state; the menu is pure render,
 * so every branch here is asserted against props alone (no composer harness):
 *
 *   Stage "type"   — one row per reference kind (testid mention-type-<type>);
 *                    the row at activeIndex is aria-selected; click →
 *                    onSelectType(info); hover → onHoverIndex(index); an empty
 *                    type list renders "No reference types match."
 *   Stage "search" — the header shows the selected type's pluralLabel; result
 *                    rows (testid mention-result-<index>) render label +
 *                    description; click → onSelectResult(row); and the three
 *                    empty/loading states (Searching… / Type to search. /
 *                    No matches.) render for the right prop combinations.
 */

import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MENTION_TYPES } from "@oxagen/ai/mentions";
import { MentionMenu } from "./mention-menu";
import type { MentionSearchResult } from "./mention-meta";

afterEach(cleanup);

const fileType = MENTION_TYPES.find((t) => t.type === "file")!;

const RESULTS: readonly MentionSearchResult[] = [
  {
    type: "file",
    slug: "apps/app/src/proxy.ts",
    location: "apps/app/src/proxy.ts",
    label: "proxy.ts",
    description: "Edge request interception",
    properties: { size: 1200 },
  },
  {
    type: "file",
    slug: "apps/app/src/app.ts",
    location: "apps/app/src/app.ts",
    label: "app.ts",
    description: "App bootstrap",
    properties: {},
  },
];

type MenuProps = React.ComponentProps<typeof MentionMenu>;

/** Build a full prop set with sensible defaults, overridable per test. */
function props(overrides: Partial<MenuProps>): MenuProps {
  return {
    stage: "type",
    types: MENTION_TYPES,
    results: [],
    selectedType: null,
    activeIndex: 0,
    loading: false,
    query: "",
    onSelectType: vi.fn(),
    onSelectResult: vi.fn(),
    onHoverIndex: vi.fn(),
    ...overrides,
  };
}

describe("MentionMenu — stage 'type'", () => {
  it("renders one option per reference type", () => {
    render(<MentionMenu {...props({ stage: "type" })} />);
    expect(screen.getByTestId("mention-menu")).toBeInTheDocument();
    for (const info of MENTION_TYPES) {
      expect(
        screen.getByTestId(`mention-type-${info.type}`),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByRole("option")).toHaveLength(MENTION_TYPES.length);
  });

  it("marks the row at activeIndex as aria-selected", () => {
    render(<MentionMenu {...props({ stage: "type", activeIndex: 2 })} />);
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
  });

  it("calls onSelectType with the clicked type", async () => {
    const onSelectType = vi.fn();
    render(<MentionMenu {...props({ stage: "type", onSelectType })} />);
    await userEvent.click(screen.getByTestId(`mention-type-${fileType.type}`));
    expect(onSelectType).toHaveBeenCalledTimes(1);
    expect(onSelectType).toHaveBeenCalledWith(fileType);
  });

  it("calls onHoverIndex with the hovered row's index", async () => {
    const onHoverIndex = vi.fn();
    render(<MentionMenu {...props({ stage: "type", onHoverIndex })} />);
    await userEvent.hover(
      screen.getByTestId(`mention-type-${MENTION_TYPES[1]!.type}`),
    );
    expect(onHoverIndex).toHaveBeenCalledWith(1);
  });

  it("shows the empty message when no types match", () => {
    render(<MentionMenu {...props({ stage: "type", types: [] })} />);
    expect(screen.getByText("No reference types match.")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

describe("MentionMenu — stage 'search'", () => {
  it("shows the selected type's plural label in the header", () => {
    render(
      <MentionMenu
        {...props({
          stage: "search",
          selectedType: fileType,
          results: RESULTS,
          query: "pro",
        })}
      />,
    );
    expect(screen.getByText(fileType.pluralLabel)).toBeInTheDocument();
  });

  it("renders each result's label and description", () => {
    render(
      <MentionMenu
        {...props({
          stage: "search",
          selectedType: fileType,
          results: RESULTS,
          query: "",
        })}
      />,
    );
    expect(screen.getByText("proxy.ts")).toBeInTheDocument();
    expect(screen.getByText("Edge request interception")).toBeInTheDocument();
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(RESULTS.length);
  });

  it("calls onSelectResult with the clicked row", async () => {
    const onSelectResult = vi.fn();
    render(
      <MentionMenu
        {...props({
          stage: "search",
          selectedType: fileType,
          results: RESULTS,
          onSelectResult,
        })}
      />,
    );
    await userEvent.click(screen.getByTestId("mention-result-0"));
    expect(onSelectResult).toHaveBeenCalledTimes(1);
    expect(onSelectResult).toHaveBeenCalledWith(RESULTS[0]);
  });

  it("shows a loading state while fetching the first page", () => {
    render(
      <MentionMenu
        {...props({
          stage: "search",
          selectedType: fileType,
          results: [],
          loading: true,
          query: "pro",
        })}
      />,
    );
    expect(screen.getByText(/Searching/)).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("prompts to type when the query is empty and there are no results", () => {
    render(
      <MentionMenu
        {...props({
          stage: "search",
          selectedType: fileType,
          results: [],
          query: "",
        })}
      />,
    );
    expect(screen.getByText("Type to search.")).toBeInTheDocument();
  });

  it("shows a no-matches state for a non-empty query with no results", () => {
    render(
      <MentionMenu
        {...props({
          stage: "search",
          selectedType: fileType,
          results: [],
          query: "zzz",
        })}
      />,
    );
    expect(screen.getByText("No matches.")).toBeInTheDocument();
  });
});
