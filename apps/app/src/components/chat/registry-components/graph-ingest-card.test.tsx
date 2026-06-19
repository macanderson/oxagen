// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import GraphIngestCard from "./graph-ingest-card";

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

afterEach(cleanup);

const output = {
  summary: "Ingested 2 entities and 1 relationship into the knowledge graph.",
  entities: [
    { nodeId: "n_1", name: "USS Nautilus", type: "Vessel", confidence: 0.95, created: true },
    { nodeId: "n_2", name: "Hyman Rickover", type: "Person", confidence: 0.8, created: false },
  ],
  relationships: [
    { edgeId: "n_2:CREATED_BY:n_1", from: "Hyman Rickover", to: "USS Nautilus", edgeType: "CREATED_BY", confidence: 0.7, created: true },
  ],
};

describe("GraphIngestCard", () => {
  it("renders entities with type, confidence, and deep links + relationships", () => {
    render(<GraphIngestCard output={output} orgSlug="acme" workspaceSlug="ws" />);
    expect(screen.getByText("Knowledge graph updated")).toBeTruthy();
    expect(screen.getByText("2 nodes · 1 edge")).toBeTruthy();
    // entity deep-links to node detail ("USS Nautilus" also appears in the
    // relationship row, so pick the one that is an anchor).
    const link = screen
      .getAllByText("USS Nautilus")
      .map((el) => el.closest("a"))
      .find((a): a is HTMLAnchorElement => a !== null);
    expect(link?.getAttribute("href")).toBe("/acme/ws/knowledge/nodes/n_1");
    // type badge + confidence shown
    expect(screen.getByText("Vessel")).toBeTruthy();
    expect(screen.getByText("95%")).toBeTruthy();
    // relationship edge type
    expect(screen.getByText("CREATED_BY")).toBeTruthy();
  });

  it("renders an empty state when nothing was extracted", () => {
    render(<GraphIngestCard output={{ summary: "", entities: [], relationships: [] }} />);
    expect(screen.getByText("No entities were extracted from the text.")).toBeTruthy();
  });
});
