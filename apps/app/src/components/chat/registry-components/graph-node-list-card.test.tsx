// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import GraphNodeListCard from "./graph-node-list-card";

// TruncatedText (the row description) measures scroll overflow via
// ResizeObserver, which isn't implemented in JSDOM.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

describe("GraphNodeListCard", () => {
  it("renders graph.node.list rows deep-linked to node detail pages", () => {
    render(
      <GraphNodeListCard
        output={{
          nodes: [
            { id: "n_1", displayName: "USS Nautilus", labels: ["Vessel"] },
            { id: "n_2", displayName: "Arctic Voyage", labels: ["Event"] },
          ],
          total: 2,
        }}
        orgSlug="acme"
        workspaceSlug="ws"
      />,
    );
    expect(screen.getByText("2 nodes")).toBeTruthy();
    const link = screen.getByText("USS Nautilus").closest("a");
    expect(link?.getAttribute("href")).toBe("/acme/ws/knowledge/graph/n_1");
  });

  it("renders graph.node.search rows with a relevance score", () => {
    render(
      <GraphNodeListCard
        output={{
          nodes: [{ nodeId: "n_3", displayName: "Reactor", score: 0.5 }],
        }}
        orgSlug="acme"
        workspaceSlug="ws"
      />,
    );
    expect(screen.getByText("Reactor")).toBeTruthy();
    expect(screen.getByText("0.50")).toBeTruthy();
  });

  it("renders an empty state", () => {
    render(<GraphNodeListCard output={{ nodes: [], total: 0 }} />);
    expect(screen.getByText("No matching nodes.")).toBeTruthy();
  });

  it("renders a row description outside the deep-link anchor (no nested interactive elements)", () => {
    render(
      <GraphNodeListCard
        output={{
          nodes: [
            {
              id: "n_4",
              displayName: "Reactor Core",
              description: "A compact PWR design.",
            },
          ],
          total: 1,
        }}
        orgSlug="acme"
        workspaceSlug="ws"
      />,
    );
    const description = screen.getByText("A compact PWR design.");
    expect(description.closest("a")).toBeNull();
  });
});
