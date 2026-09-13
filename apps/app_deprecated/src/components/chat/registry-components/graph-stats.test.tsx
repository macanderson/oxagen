// @vitest-environment jsdom
import { render, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import GraphStatsBlock from "./graph-stats";

afterEach(cleanup);

describe("graph-stats chat renderer", () => {
  it("maps the agent's graph.stats props onto the shared stat boxes", () => {
    const props: Record<string, unknown> = {
      nodeCount: 42,
      edgeCount: 9,
      inferredEdgeCount: 2,
      sourceCount: 1,
    };
    const { getByTestId, getByText } = render(<GraphStatsBlock {...props} />);
    expect(getByTestId("graph-stats")).toBeInTheDocument();
    expect(getByText("42")).toBeInTheDocument();
    expect(getByText("9")).toBeInTheDocument();
  });

  it("defensively coerces non-numeric / missing props to 0", () => {
    const props: Record<string, unknown> = {
      nodeCount: "oops",
      edgeCount: null,
    };
    const { getAllByText, getByText } = render(<GraphStatsBlock {...props} />);
    // All four counts fall back to 0.
    expect(getAllByText("0").length).toBe(4);
    expect(getByText("Nodes")).toBeInTheDocument();
  });
});
