// @vitest-environment jsdom
import { render, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { GraphStatsBoxes } from "./graph-stats";

afterEach(cleanup);

describe("GraphStatsBoxes", () => {
  it("renders node/edge/inferred/source counts with thousands separators", () => {
    const { getByText, getByTestId } = render(
      <GraphStatsBoxes
        stats={{
          nodeCount: 1234,
          edgeCount: 56,
          inferredEdgeCount: 7,
          sourceCount: 3,
        }}
      />,
    );
    expect(getByTestId("graph-stats")).toBeInTheDocument();
    // Locale-robust: match the node count by its digits regardless of the
    // grouping separator the runtime locale chooses.
    expect(
      getByText((content) => content.replace(/\D/g, "") === "1234"),
    ).toBeInTheDocument();
    expect(getByText("56")).toBeInTheDocument();
    expect(getByText("Nodes")).toBeInTheDocument();
    expect(getByText("Edges")).toBeInTheDocument();
    expect(getByText("Inferred")).toBeInTheDocument();
    expect(getByText("Sources")).toBeInTheDocument();
  });

  it("shows a last-updated caption only when lastModifiedAt is a valid timestamp", () => {
    const { queryByText, rerender } = render(
      <GraphStatsBoxes
        stats={{
          nodeCount: 0,
          edgeCount: 0,
          inferredEdgeCount: 0,
          sourceCount: 0,
        }}
      />,
    );
    expect(queryByText(/Last updated/)).not.toBeInTheDocument();

    // Epoch timestamp (0) should not display
    rerender(
      <GraphStatsBoxes
        stats={{
          nodeCount: 0,
          edgeCount: 0,
          inferredEdgeCount: 0,
          sourceCount: 0,
          lastModifiedAt: "1970-01-01T00:00:00Z",
        }}
      />,
    );
    expect(queryByText(/Last updated/)).not.toBeInTheDocument();

    // Valid timestamp should display
    rerender(
      <GraphStatsBoxes
        stats={{
          nodeCount: 0,
          edgeCount: 0,
          inferredEdgeCount: 0,
          sourceCount: 0,
          lastModifiedAt: "2026-06-10T14:05:00Z",
        }}
      />,
    );
    expect(queryByText(/Last updated/)).toBeInTheDocument();
  });
});
