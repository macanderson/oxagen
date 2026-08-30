// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import GraphNodeCard from "./graph-node-card";

// TruncatedText (description + property values) measures scroll overflow via
// ResizeObserver, which isn't implemented in JSDOM.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

describe("GraphNodeCard", () => {
  it("renders a graph.node.get node with its detail deep-link", () => {
    render(
      <GraphNodeCard
        output={{
          node: {
            nodeId: "n_7",
            label: "Person",
            displayName: "Hyman Rickover",
            description: "Father of the Nuclear Navy",
            properties: { rank: "Admiral" },
          },
        }}
        links={[
          {
            field: "node.nodeId",
            recordType: "graph.node",
            id: "n_7",
            href: "/acme/ws/knowledge/graph/n_7",
            label: "Hyman Rickover",
          },
        ]}
      />,
    );
    expect(screen.getByText("Hyman Rickover")).toBeTruthy();
    expect(screen.getByText("Person")).toBeTruthy();
    expect(screen.getByText("Father of the Nuclear Navy")).toBeTruthy();
    expect(screen.getByText("Admiral")).toBeTruthy();
    const open = screen.getByText("Open node").closest("a");
    expect(open?.getAttribute("href")).toBe("/acme/ws/knowledge/graph/n_7");
  });

  it("renders a graph.node.upsert result with a success-toned New label", () => {
    render(
      <GraphNodeCard output={{ nodeId: "n_9", created: true }} links={[]} />,
    );
    const newLabel = screen.getByText("New");
    expect(newLabel).toBeTruthy();
    expect(newLabel.className).toContain("text-success");
    expect(screen.getByText("n_9")).toBeTruthy();
  });

  it("shows a not-found state when the node is null", () => {
    render(<GraphNodeCard output={{ node: null }} links={[]} />);
    expect(screen.getByText("Node not found.")).toBeTruthy();
  });
});
