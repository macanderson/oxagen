// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ResearchSwarmCard from "./research-swarm-card";

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

afterEach(cleanup);

describe("ResearchSwarmCard", () => {
  it("shows a running progress indicator from completed/total tasks", () => {
    render(
      <ResearchSwarmCard
        output={{ swarmId: "swm_1", dispatchId: "fan_1", status: "running", completedTasks: 3, totalTasks: 15 }}
      />,
    );
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("3 / 15 tasks")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("20");
    expect(screen.getByText("swm_1")).toBeTruthy();
  });

  it("renders a complete swarm with the per-query result breakdown", () => {
    render(
      <ResearchSwarmCard
        output={{
          swarmId: "swm_2",
          status: "complete",
          completedTasks: 2,
          totalTasks: 2,
          results: [
            { query: "USS Nautilus crew", resultCount: 5 },
            { query: "Nautilus Arctic voyage", resultCount: 3 },
          ],
        }}
      />,
    );
    expect(screen.getByText("Complete")).toBeTruthy();
    expect(screen.getByText("USS Nautilus crew")).toBeTruthy();
    expect(screen.getByText("5 results")).toBeTruthy();
    expect(screen.getByText("3 results")).toBeTruthy();
  });

  it("renders a failed swarm", () => {
    render(<ResearchSwarmCard output={{ status: "failed", completedTasks: 0, totalTasks: 4 }} />);
    expect(screen.getByText("Failed")).toBeTruthy();
  });
});
