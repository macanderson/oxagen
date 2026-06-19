// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import GraphNodeListCard from "./graph-node-list-card";

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

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
    expect(link?.getAttribute("href")).toBe("/acme/ws/knowledge/nodes/n_1");
  });

  it("renders graph.node.search rows with a relevance score", () => {
    render(
      <GraphNodeListCard
        output={{ nodes: [{ nodeId: "n_3", displayName: "Reactor", score: 0.5 }] }}
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
});
