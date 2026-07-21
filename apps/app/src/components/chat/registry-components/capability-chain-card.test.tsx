// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CapabilityChainCard from "./capability-chain-card";

// TruncatedText (the step rationale renderer) measures scroll overflow via
// ResizeObserver, which isn't implemented in JSDOM.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

const output = {
  goal: "Research USS Nautilus and add nodes",
  summary: "Searched the web and created 2 graph nodes.",
  executed: true,
  steps: [
    {
      id: "step1",
      capability: "search_web",
      rationale: "Find sources",
      status: "success",
      input: { query: "USS Nautilus" },
      output: { totalResults: 5 },
      durationMs: 120,
    },
    {
      id: "step2",
      capability: "query_ontology",
      rationale: "Create the vessel node",
      status: "error",
      input: { label: "Vessel" },
      error: "Neo4j unavailable",
      durationMs: 30,
    },
    {
      id: "step3",
      capability: "purchase_credits",
      rationale: "Would buy credits",
      status: "skipped",
      input: null,
      error:
        "Capability is destructive or requires approval — not auto-executed.",
      durationMs: 0,
    },
  ],
};

describe("CapabilityChainCard", () => {
  it("renders the summary, goal, run count, and each step", () => {
    render(<CapabilityChainCard output={output} />);
    expect(
      screen.getByText("Searched the web and created 2 graph nodes."),
    ).toBeTruthy();
    expect(screen.getByText(/Research USS Nautilus/)).toBeTruthy();
    expect(screen.getByText("1/3 ran")).toBeTruthy();
    expect(screen.getByText("search_web")).toBeTruthy();
    expect(screen.getByText("query_ontology")).toBeTruthy();
    expect(screen.getByText("Find sources")).toBeTruthy();
  });

  it("expands a step to reveal its input and output on click", async () => {
    const user = userEvent.setup();
    render(<CapabilityChainCard output={output} />);
    // The web.search step button (first expandable) reveals Input/Output panes.
    const stepButton = screen
      .getByText("search_web")
      .closest("button") as HTMLButtonElement;
    await user.click(stepButton);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Output")).toBeTruthy();
  });

  it("shows an empty state when there are no steps", () => {
    render(
      <CapabilityChainCard
        output={{ goal: "g", summary: "", executed: false, steps: [] }}
      />,
    );
    expect(screen.getByText("No steps were planned.")).toBeTruthy();
    expect(screen.getByText("Plan only")).toBeTruthy();
  });
});
