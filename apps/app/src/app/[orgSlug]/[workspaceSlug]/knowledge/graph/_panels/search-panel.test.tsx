// @vitest-environment jsdom
/**
 * search-panel.test.tsx
 *
 * Covers: idle state before typing, debounced fuzzy search (search_nodes),
 * the semantic toggle switching to graph.search (search_graph), no-match
 * empty state, and the error state.
 *
 * Fake timers drive the 300ms debounce — `act()`-wrapped `runAllTimersAsync()`
 * then a synchronous assertion is the established pattern in this repo (see
 * org-privacy-panel.test.tsx) rather than `waitFor`, which itself relies on
 * timers that are faked here.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";

const { mockSearchNodes, mockSemanticSearch } = vi.hoisted(() => ({
  mockSearchNodes: vi.fn(),
  mockSemanticSearch: vi.fn(),
}));

vi.mock("../actions", () => ({
  searchNodesAction: mockSearchNodes,
  semanticSearchAction: mockSemanticSearch,
}));

vi.mock("@/components/knowledge/graph/node-ref", () => ({
  NodeRef: ({ node }: { node: { displayName: string } }) => (
    <span data-testid="node-ref">{node.displayName}</span>
  ),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

// `@/components/ui/switch` mocked to a plain `role="switch"` button — the
// established pattern in this repo (see mcp-server-picker.test.tsx) since the
// real Base UI Switch needs pointer-capture support jsdom doesn't provide.
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    id?: string;
  }) => (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked ?? false}
      onClick={() => onCheckedChange?.(!checked)}
    />
  ),
}));

import { SearchPanel } from "./search-panel";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Flush the 300ms debounce timer + its resulting async server-action call. */
async function flushDebounce() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

describe("SearchPanel", () => {
  it("shows the idle prompt before any query is typed", () => {
    render(<SearchPanel orgSlug="acme" workspaceSlug="core" />);
    expect(screen.getByText("Type to search")).toBeInTheDocument();
    expect(mockSearchNodes).not.toHaveBeenCalled();
  });

  it("debounces and calls search_nodes (fuzzy) by default", async () => {
    mockSearchNodes.mockResolvedValue({
      ok: true,
      nodes: [
        {
          nodeId: "pub-1",
          label: "Feature",
          displayName: "Billing",
          description: null,
          score: 1,
        },
      ],
    });
    render(<SearchPanel orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Search graph nodes"), {
      target: { value: "bill" },
    });

    // Not called until the debounce elapses.
    expect(mockSearchNodes).not.toHaveBeenCalled();
    await flushDebounce();

    expect(screen.getByText("Billing")).toBeInTheDocument();
    expect(mockSearchNodes).toHaveBeenCalledWith(
      expect.objectContaining({
        orgSlug: "acme",
        workspaceSlug: "core",
        query: "bill",
        limit: 20,
      }),
    );
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it("calls search_graph (semantic) when the toggle is on", async () => {
    mockSemanticSearch.mockResolvedValue({
      ok: true,
      results: [
        {
          nodeId: "pub-2",
          label: "SourceFile",
          displayName: "billing.ts",
          kind: "entity",
          snippet: "charge()",
          score: 0.9,
        },
      ],
    });
    render(<SearchPanel orgSlug="acme" workspaceSlug="core" />);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByLabelText("Search graph nodes"), {
      target: { value: "charging logic" },
    });
    await flushDebounce();

    expect(screen.getByText("billing.ts")).toBeInTheDocument();
    expect(mockSemanticSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: "charging logic", limit: 20 }),
    );
    expect(mockSearchNodes).not.toHaveBeenCalled();
  });

  it("shows a no-match empty state for zero results", async () => {
    mockSearchNodes.mockResolvedValue({ ok: true, nodes: [] });
    render(<SearchPanel orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Search graph nodes"), {
      target: { value: "nope" },
    });
    await flushDebounce();
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("shows an error state when the action fails", async () => {
    mockSearchNodes.mockResolvedValue({
      ok: false,
      error: "index unavailable",
    });
    render(<SearchPanel orgSlug="acme" workspaceSlug="core" />);
    fireEvent.change(screen.getByLabelText("Search graph nodes"), {
      target: { value: "x" },
    });
    await flushDebounce();
    expect(screen.getByText("index unavailable")).toBeInTheDocument();
  });

  it("clearing the query returns to idle", async () => {
    mockSearchNodes.mockResolvedValue({
      ok: true,
      nodes: [
        {
          nodeId: "pub-1",
          label: "Feature",
          displayName: "Billing",
          description: null,
          score: 1,
        },
      ],
    });
    render(<SearchPanel orgSlug="acme" workspaceSlug="core" />);
    const input = screen.getByLabelText("Search graph nodes");
    fireEvent.change(input, { target: { value: "bill" } });
    await flushDebounce();
    expect(screen.getByText("Billing")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("Type to search")).toBeInTheDocument();
  });
});
