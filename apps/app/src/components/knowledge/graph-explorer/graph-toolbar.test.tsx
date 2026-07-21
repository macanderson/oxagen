// @vitest-environment jsdom
/**
 * graph-toolbar.test.tsx — render + interaction tests for GraphToolbar.
 *
 * Covers: search input submit calls onSearch with trimmed query, stats line
 * renders node/edge counts, view SegmentedControl switches call onViewChange,
 * canvas action buttons call their callbacks, canvas buttons are absent in
 * table view, reload button calls onReload, and the compact (<md) mode that
 * collapses secondary actions into a "More actions" menu (matchMedia mocked).
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import { GraphToolbar, type GraphToolbarProps } from "./graph-toolbar";
import type { ExplorerStats } from "./types";

// The Base UI menu opens through portal/positioner machinery jsdom can't
// exercise; a pass-through mock keeps the assertions about which actions the
// toolbar routes into the menu.
vi.mock("@/components/ui/menu", () => ({
  Menu: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({
    children,
    render: renderEl,
  }: {
    children?: React.ReactNode;
    render?: React.ReactElement<{ "aria-label"?: string }>;
  }) => (
    <button type="button" aria-label={renderEl?.props["aria-label"]}>
      {children}
    </button>
  ),
  MenuPopup: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="menu-popup">{children}</div>
  ),
  MenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  MenuSeparator: () => <hr />,
}));

function setMatchMedia(matches: (query: string) => boolean) {
  window.matchMedia = ((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

const noopStats: ExplorerStats = {
  nodeCount: 100,
  edgeCount: 50,
  inferredEdgeCount: 10,
  nodesByLabel: [],
  edgesByType: [],
};

function makeProps(
  overrides: Partial<GraphToolbarProps> = {},
): GraphToolbarProps {
  return {
    view: "2d",
    onViewChange: vi.fn(),
    stats: null,
    inViewNodeCount: 0,
    inViewEdgeCount: 0,
    searching: false,
    onSearch: vi.fn(),
    draggable: false,
    onToggleDraggable: vi.fn(),
    canvasReady: true,
    animated: true,
    onToggleAnimated: vi.fn(),
    onFit: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onScreenshot: vi.fn(),
    onReload: vi.fn(),
    ...overrides,
  };
}

describe("GraphToolbar — search", () => {
  it("renders a search input with aria-label", () => {
    render(<GraphToolbar {...makeProps()} />);
    expect(
      screen.getByRole("textbox", { name: /search the graph/i }),
    ).toBeInTheDocument();
  });

  it("submitting the form with a non-empty query calls onSearch with trimmed value", () => {
    const onSearch = vi.fn();
    render(<GraphToolbar {...makeProps({ onSearch })} />);
    const input = screen.getByRole("textbox", { name: /search the graph/i });
    fireEvent.change(input, { target: { value: "  hello world  " } });
    fireEvent.submit(input.closest("form")!);
    expect(onSearch).toHaveBeenCalledWith("hello world");
  });

  it("does not call onSearch when query is blank", () => {
    const onSearch = vi.fn();
    render(<GraphToolbar {...makeProps({ onSearch })} />);
    const input = screen.getByRole("textbox", { name: /search the graph/i });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    expect(onSearch).not.toHaveBeenCalled();
  });
});

describe("GraphToolbar — stats display", () => {
  it("renders in-view node and edge counts when stats provided", () => {
    render(
      <GraphToolbar
        {...makeProps({
          stats: noopStats,
          inViewNodeCount: 42,
          inViewEdgeCount: 17,
        })}
      />,
    );
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("100 nodes")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
    expect(screen.getByText("50 edges")).toBeInTheDocument();
  });

  it("does not render stats when stats is null", () => {
    render(<GraphToolbar {...makeProps({ stats: null })} />);
    expect(screen.queryByText(/nodes/)).not.toBeInTheDocument();
    expect(screen.queryByText(/edges/)).not.toBeInTheDocument();
  });
});

describe("GraphToolbar — view segmented control", () => {
  it("renders 2D graph, 3D graph, Table view items", () => {
    render(<GraphToolbar {...makeProps()} />);
    expect(
      screen.getByRole("button", { name: /2d graph/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /3d graph/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /table/i })).toBeInTheDocument();
  });

  it("clicking '3D graph' calls onViewChange with '3d'", () => {
    const onViewChange = vi.fn();
    render(<GraphToolbar {...makeProps({ onViewChange })} />);
    fireEvent.click(screen.getByRole("button", { name: /3d graph/i }));
    expect(onViewChange).toHaveBeenCalledWith("3d");
  });

  it("clicking 'Table' calls onViewChange with 'table'", () => {
    const onViewChange = vi.fn();
    render(<GraphToolbar {...makeProps({ onViewChange })} />);
    fireEvent.click(screen.getByRole("button", { name: /^table$/i }));
    expect(onViewChange).toHaveBeenCalledWith("table");
  });

  it("clicking '2D graph' calls onViewChange with '2d'", () => {
    const onViewChange = vi.fn();
    render(<GraphToolbar {...makeProps({ view: "3d", onViewChange })} />);
    fireEvent.click(screen.getByRole("button", { name: /2d graph/i }));
    expect(onViewChange).toHaveBeenCalledWith("2d");
  });
});

describe("GraphToolbar — canvas action buttons (2d/3d view)", () => {
  it("renders Fit, Zoom in/out, Dragging, Screenshot buttons in 2d view", () => {
    render(<GraphToolbar {...makeProps({ view: "2d", canvasReady: true })} />);
    expect(
      screen.getByRole("button", { name: /fit to view/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /zoom in/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /zoom out/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download screenshot/i }),
    ).toBeInTheDocument();
  });

  it("clicking 'Fit to view' calls onFit", () => {
    const onFit = vi.fn();
    render(
      <GraphToolbar {...makeProps({ onFit, view: "2d", canvasReady: true })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /fit to view/i }));
    expect(onFit).toHaveBeenCalledOnce();
  });

  it("clicking 'Zoom in' calls onZoomIn", () => {
    const onZoomIn = vi.fn();
    render(
      <GraphToolbar
        {...makeProps({ onZoomIn, view: "2d", canvasReady: true })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /zoom in/i }));
    expect(onZoomIn).toHaveBeenCalledOnce();
  });

  it("clicking 'Zoom out' calls onZoomOut", () => {
    const onZoomOut = vi.fn();
    render(
      <GraphToolbar
        {...makeProps({ onZoomOut, view: "2d", canvasReady: true })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /zoom out/i }));
    expect(onZoomOut).toHaveBeenCalledOnce();
  });

  it("clicking 'Download screenshot' calls onScreenshot", () => {
    const onScreenshot = vi.fn();
    render(
      <GraphToolbar
        {...makeProps({ onScreenshot, view: "2d", canvasReady: true })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /download screenshot/i }),
    );
    expect(onScreenshot).toHaveBeenCalledOnce();
  });

  it("canvas action buttons are disabled when canvasReady=false", () => {
    render(<GraphToolbar {...makeProps({ view: "2d", canvasReady: false })} />);
    expect(screen.getByRole("button", { name: /fit to view/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /zoom in/i })).toBeDisabled();
  });

  it("canvas action buttons are not rendered in table view", () => {
    render(<GraphToolbar {...makeProps({ view: "table" })} />);
    expect(
      screen.queryByRole("button", { name: /fit to view/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /zoom in/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /download screenshot/i }),
    ).not.toBeInTheDocument();
  });
});

describe("GraphToolbar — reload", () => {
  it("renders the Reload graph button", () => {
    render(<GraphToolbar {...makeProps()} />);
    expect(
      screen.getByRole("button", { name: /reload graph/i }),
    ).toBeInTheDocument();
  });

  it("clicking Reload calls onReload", () => {
    const onReload = vi.fn();
    render(<GraphToolbar {...makeProps({ onReload })} />);
    fireEvent.click(screen.getByRole("button", { name: /reload graph/i }));
    expect(onReload).toHaveBeenCalledOnce();
  });
});

describe("GraphToolbar — compact mode (<md)", () => {
  beforeEach(() => {
    setMatchMedia((q) => q === "(max-width: 767px)");
  });

  it("keeps search, fit-to-view, and the view switcher inline", () => {
    render(<GraphToolbar {...makeProps({ view: "2d", canvasReady: true })} />);
    expect(
      screen.getByRole("textbox", { name: /search the graph/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /fit to view/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /2d graph/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /more actions/i }),
    ).toBeInTheDocument();
  });

  it("moves zoom, drag, screenshot, and reload actions into the menu", () => {
    render(<GraphToolbar {...makeProps({ view: "2d", canvasReady: true })} />);
    const popup = within(screen.getByTestId("menu-popup"));
    expect(
      popup.getByRole("menuitem", { name: /zoom in/i }),
    ).toBeInTheDocument();
    expect(
      popup.getByRole("menuitem", { name: /zoom out/i }),
    ).toBeInTheDocument();
    expect(
      popup.getByRole("menuitem", { name: /dragging/i }),
    ).toBeInTheDocument();
    expect(
      popup.getByRole("menuitem", { name: /download screenshot/i }),
    ).toBeInTheDocument();
    expect(
      popup.getByRole("menuitem", { name: /reload graph/i }),
    ).toBeInTheDocument();
    // No standalone inline zoom button remains outside the menu.
    expect(
      screen.queryByRole("button", { name: /zoom in/i }),
    ).not.toBeInTheDocument();
  });

  it("menu actions invoke their callbacks", () => {
    const onZoomIn = vi.fn();
    const onReload = vi.fn();
    render(
      <GraphToolbar
        {...makeProps({
          onZoomIn,
          onReload,
          view: "2d",
          canvasReady: true,
        })}
      />,
    );
    const popup = within(screen.getByTestId("menu-popup"));
    fireEvent.click(popup.getByRole("menuitem", { name: /zoom in/i }));
    fireEvent.click(popup.getByRole("menuitem", { name: /reload graph/i }));
    expect(onZoomIn).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledOnce();
  });

  it("omits canvas-only menu items in table view but keeps reload", () => {
    render(<GraphToolbar {...makeProps({ view: "table" })} />);
    const popup = within(screen.getByTestId("menu-popup"));
    expect(
      popup.queryByRole("menuitem", { name: /zoom in/i }),
    ).not.toBeInTheDocument();
    expect(
      popup.queryByRole("menuitem", { name: /download screenshot/i }),
    ).not.toBeInTheDocument();
    expect(
      popup.getByRole("menuitem", { name: /reload graph/i }),
    ).toBeInTheDocument();
    // Fit-to-view is canvas-only and stays hidden in table view.
    expect(
      screen.queryByRole("button", { name: /fit to view/i }),
    ).not.toBeInTheDocument();
  });

  it("search input uses a 16px font below md to prevent iOS zoom", () => {
    render(<GraphToolbar {...makeProps({ view: "2d" })} />);
    const input = screen.getByRole("textbox", { name: /search the graph/i });
    expect(input.className).toContain("text-base");
  });
});

describe("GraphToolbar — draggable toggle", () => {
  it("clicking the Dragging button calls onToggleDraggable", () => {
    const onToggleDraggable = vi.fn();
    render(
      <GraphToolbar
        {...makeProps({ onToggleDraggable, view: "2d", canvasReady: true })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dragging/i }));
    expect(onToggleDraggable).toHaveBeenCalledOnce();
  });
});
