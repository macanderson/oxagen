// @vitest-environment jsdom
/**
 * node-ref-link.test.tsx — render tests for NodeRefLink.
 *
 * Covers NodeRefLink's own wiring (not NodeRef's citation behavior, which has
 * its own tests at ./node-ref.test.tsx — same split as
 * knowledge/graph/_panels/graph-result-row.test.tsx, the sibling component
 * this one mirrors): the NodeRef chip still renders, the "open detail" link
 * appears with the right href + accessible name when `href` is given, and no
 * link renders when `href` is omitted (unmaterialised candidate case).
 */

import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("./node-ref", () => ({
  NodeRef: ({ node }: { node: { displayName: string } }) => (
    <span data-testid="node-ref">{node.displayName}</span>
  ),
  // Mirror the real (pure) citation-label helper — its own behavior is covered
  // by node-ref.test.tsx; here it only needs to feed NodeRefLink's aria-label.
  nodeCitationLabel: (node: {
    displayName?: string;
    label?: string;
    id?: string | null;
  }) => {
    const name = node.displayName?.trim();
    if (name && name !== node.id) return name;
    if (node.label && node.label !== "Node") return node.label;
    return node.label || "Unknown node";
  },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { NodeRefLink } from "./node-ref-link";
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/semantic.edge.list";

afterEach(cleanup);

function makeNode(overrides: Partial<KnowledgeNodeRef> = {}): KnowledgeNodeRef {
  return {
    id: "kn_1",
    label: "Feature",
    displayName: "Billing Subscription",
    properties: {},
    ...overrides,
  };
}

describe("NodeRefLink", () => {
  it("renders the NodeRef chip citation", () => {
    render(<NodeRefLink node={makeNode()} href="/acme/main/knowledge/graph/kn_1" />);
    expect(screen.getByTestId("node-ref")).toHaveTextContent("Billing Subscription");
  });

  it("renders a link to the given href with an accessible open-detail label", () => {
    render(<NodeRefLink node={makeNode()} href="/acme/main/knowledge/graph/kn_1" />);
    const link = screen.getByRole("link", { name: /open billing subscription detail/i });
    expect(link).toHaveAttribute("href", "/acme/main/knowledge/graph/kn_1");
  });

  it("renders no link when href is omitted", () => {
    render(<NodeRefLink node={makeNode()} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders no link when href is null (unmaterialised candidate)", () => {
    render(<NodeRefLink node={makeNode({ id: null })} href={null} />);
    expect(screen.queryByRole("link")).toBeNull();
    // Still cited via NodeRef, just not clickable.
    expect(screen.getByTestId("node-ref")).toBeInTheDocument();
  });

  it("falls back to the domain label for the accessible link name when displayName is empty", () => {
    render(
      <NodeRefLink
        node={makeNode({ displayName: "" })}
        href="/acme/main/knowledge/graph/kn_1"
      />,
    );
    expect(screen.getByRole("link", { name: /open feature detail/i })).toBeInTheDocument();
  });
});
