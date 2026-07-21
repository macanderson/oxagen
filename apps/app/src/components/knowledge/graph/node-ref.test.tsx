// @vitest-environment jsdom
/**
 * node-ref.test.tsx — the node-citation rule, in tests.
 *
 * A node is cited by its human label (displayName + domain label), never by its
 * raw UUID, and the full property bag is available on inspect. The Base UI
 * popover is mocked to render inline so the popup content is assertable in
 * jsdom (the floating/portal behaviour is Base UI's concern, not ours).
 */

import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    children,
    "aria-label": ariaLabel,
    className,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
    className?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} className={className}>
      {children}
    </button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { NodeRef } from "./node-ref";
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/knowledge.node-ref";

afterEach(cleanup);

const SOURCE_UUID = "913d6df1-5dca-4bc7-aff6-193939228260";

function makeNode(overrides: Partial<KnowledgeNodeRef> = {}): KnowledgeNodeRef {
  return {
    id: SOURCE_UUID,
    label: "Feature",
    displayName: "Billing Subscription Streaming",
    properties: { path: "src/billing.ts", owner: "platform" },
    ...overrides,
  };
}

describe("NodeRef", () => {
  it("cites the node by its displayName, not its UUID", () => {
    render(<NodeRef node={makeNode()} />);
    // Friendly label is shown (trigger chip + popup header → at least one).
    expect(
      screen.getAllByText("Billing Subscription Streaming").length,
    ).toBeGreaterThan(0);
    // The raw UUID is never the primary on-screen identifier.
    expect(screen.queryByText(SOURCE_UUID)).toBeNull();
  });

  it("shows the domain label and full properties on inspect", () => {
    render(<NodeRef node={makeNode()} />);
    expect(screen.getByText("Feature")).toBeInTheDocument();
    // Humanized property keys + values from the bag.
    expect(screen.getByText("Path")).toBeInTheDocument();
    expect(screen.getByText("src/billing.ts")).toBeInTheDocument();
    expect(screen.getByText("Owner")).toBeInTheDocument();
  });

  it("exposes a copyable id in the inspect panel", () => {
    render(<NodeRef node={makeNode()} />);
    // CopyableId renders an accessible copy control carrying the full id.
    expect(
      screen.getByRole("button", { name: `Copy ID ${SOURCE_UUID}` }),
    ).toBeInTheDocument();
  });

  it("marks a not-yet-materialised node (null id) as a candidate", () => {
    render(
      <NodeRef node={makeNode({ id: null, displayName: "OAuth Login" })} />,
    );
    expect(screen.getByText(/not yet materialised/i)).toBeInTheDocument();
  });

  it("falls back to the label/id when displayName is empty", () => {
    render(<NodeRef node={makeNode({ displayName: "", properties: {} })} />);
    // Label is the best remaining human identifier.
    expect(screen.getAllByText("Feature").length).toBeGreaterThan(0);
  });

  it("cites by the domain label when displayName is only the server's id fallback", () => {
    // The graph.node.list handler coalesces displayName → name → publicId, so an
    // unnamed node arrives with displayName === its own UUID. That is not a human
    // label — the chip must cite by the domain label, never the UUID.
    render(
      <NodeRef node={makeNode({ displayName: SOURCE_UUID, properties: {} })} />,
    );
    expect(screen.getAllByText("Feature").length).toBeGreaterThan(0);
    expect(screen.queryByText(SOURCE_UUID)).toBeNull();
  });

  it("never renders the raw UUID even with no name and only the base label", () => {
    // Worst case: displayName coalesced to the id AND no domain label ("Node").
    // The generic base label is still preferred over the raw id.
    render(
      <NodeRef
        node={makeNode({
          label: "Node",
          displayName: SOURCE_UUID,
          properties: {},
        })}
      />,
    );
    expect(screen.queryByText(SOURCE_UUID)).toBeNull();
    expect(screen.getAllByText("Node").length).toBeGreaterThan(0);
  });
});
