// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import GraphEdgeCard from "./graph-edge-card";

afterEach(cleanup);

describe("GraphEdgeCard", () => {
  it("splits the composite edgeId and deep-links both endpoint nodes", () => {
    render(
      <GraphEdgeCard
        output={{ edgeId: "nodeA:CREATED_BY:nodeB", created: true }}
        orgSlug="acme"
        workspaceSlug="ws"
      />,
    );
    expect(screen.getByText("Relationship created")).toBeTruthy();
    expect(screen.getByText("CREATED_BY")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
    const from = screen.getByTitle("nodeA").closest("a");
    expect(from?.getAttribute("href")).toBe("/acme/ws/knowledge/graph/nodeA");
    const to = screen.getByTitle("nodeB").closest("a");
    expect(to?.getAttribute("href")).toBe("/acme/ws/knowledge/graph/nodeB");
  });

  it("falls back to showing the raw edgeId when it cannot be split", () => {
    render(<GraphEdgeCard output={{ edgeId: "weird", created: false }} />);
    expect(screen.getByText("Relationship exists")).toBeTruthy();
    expect(screen.getByText("weird")).toBeTruthy();
  });
});
