// @vitest-environment jsdom
/**
 * graph-result-row.test.tsx
 *
 * Covers GraphResultRow's own wiring (not NodeRef's citation behavior, which
 * has its own tests at components/knowledge/graph/node-ref.test.tsx):
 *   - Open-detail link points at workspace.knowledge.node and is hidden for
 *     unmaterialised (id: null) candidates.
 *   - Expand affordance toggles and renders nested content only when expanded.
 *   - Optional `meta` trailing content renders.
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/components/knowledge/graph/node-ref", () => ({
  NodeRef: ({ node }: { node: { displayName: string } }) => (
    <span data-testid="node-ref">{node.displayName}</span>
  ),
  // Same never-the-raw-id rule as the real helper: a displayName that is just
  // the node's own id falls back to the domain label.
  nodeCitationLabel: (node: {
    displayName: string;
    label: string;
    id: string | null;
  }) =>
    node.displayName && node.displayName !== node.id
      ? node.displayName
      : node.label || "Unknown node",
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

import { GraphResultRow } from "./graph-result-row";

afterEach(cleanup);

const NODE = {
  id: "pub-1",
  label: "Feature",
  displayName: "Billing streaming",
  properties: {},
};

describe("GraphResultRow", () => {
  it("renders an open-detail link to the node-detail route", () => {
    render(<GraphResultRow node={NODE} orgSlug="acme" workspaceSlug="core" />);
    const link = screen.getByRole("link", {
      name: /open billing streaming detail/i,
    });
    expect(link).toHaveAttribute("href", "/acme/core/knowledge/graph/pub-1");
  });

  it("hides the open-detail link for an unmaterialised candidate (id: null)", () => {
    render(
      <GraphResultRow
        node={{ ...NODE, id: null, displayName: "Pending target" }}
        orgSlug="acme"
        workspaceSlug="core"
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders optional trailing meta content", () => {
    render(
      <GraphResultRow
        node={NODE}
        orgSlug="acme"
        workspaceSlug="core"
        meta={<span>0.92</span>}
      />,
    );
    expect(screen.getByText("0.92")).toBeInTheDocument();
  });

  it("does not render an expand toggle when `expand` is omitted", () => {
    render(<GraphResultRow node={NODE} orgSlug="acme" workspaceSlug="core" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("toggles expand state and only shows children when expanded", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <GraphResultRow
        node={NODE}
        orgSlug="acme"
        workspaceSlug="core"
        expand={{ expanded: false, loading: false, onToggle }}
      >
        <span>Neighbor content</span>
      </GraphResultRow>,
    );
    expect(screen.queryByText("Neighbor content")).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", {
      name: /expand billing streaming neighbors/i,
    });
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <GraphResultRow
        node={NODE}
        orgSlug="acme"
        workspaceSlug="core"
        expand={{ expanded: true, loading: false, onToggle }}
      >
        <span>Neighbor content</span>
      </GraphResultRow>,
    );
    expect(screen.getByText("Neighbor content")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /collapse billing streaming neighbors/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows a loading spinner state on the expand toggle", () => {
    render(
      <GraphResultRow
        node={NODE}
        orgSlug="acme"
        workspaceSlug="core"
        expand={{ expanded: false, loading: true, onToggle: vi.fn() }}
      />,
    );
    // The toggle button still renders (with its aria-label); loading swaps the icon only.
    expect(
      screen.getByRole("button", {
        name: /expand billing streaming neighbors/i,
      }),
    ).toBeInTheDocument();
  });
});
