// @vitest-environment jsdom
/**
 * launch-workflow-button.test.tsx — unit tests for the Workflows page-header
 * primary action. LaunchWorkflowDialog is stubbed (its own validation/submit
 * logic is covered by launch-workflow-dialog.test.tsx) and
 * useSwarmSessionStore is stubbed (its own logic is covered by
 * swarm-session-store.test.ts) — here we only prove the button owns the
 * dialog's open state and wires a launched swarm into addSwarm.
 */
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SwarmSessionRecord } from "./swarm-session-store";

const { mockAddSwarm, mockUseSwarmSessionStore } = vi.hoisted(() => ({
  mockAddSwarm: vi.fn(),
  mockUseSwarmSessionStore: vi.fn(),
}));

vi.mock("./swarm-session-store", () => ({
  useSwarmSessionStore: (...args: unknown[]) =>
    mockUseSwarmSessionStore(...args),
}));

vi.mock("./launch-workflow-dialog", () => ({
  LaunchWorkflowDialog: ({
    open,
    orgSlug,
    workspaceSlug,
    onSwarmLaunched,
  }: {
    open: boolean;
    orgSlug: string;
    workspaceSlug: string;
    onSwarmLaunched?: (record: SwarmSessionRecord) => void;
  }) =>
    open ? (
      <div data-testid="launch-workflow-dialog-stub">
        open for {orgSlug}/{workspaceSlug}
        <button
          type="button"
          data-testid="simulate-swarm-launched"
          onClick={() =>
            onSwarmLaunched?.({
              swarmId: "s1",
              dispatchId: "d1",
              topic: "AI safety funding",
              depth: "medium",
              maxParallel: 5,
              targetLabel: "Topic",
              status: "running",
              completedTasks: 0,
              totalTasks: 8,
              launchedAt: "2026-07-01T00:00:00.000Z",
            })
          }
        >
          simulate swarm launched
        </button>
      </div>
    ) : null,
}));

import { LaunchWorkflowButton } from "./launch-workflow-button";

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSwarmSessionStore.mockReturnValue({
    swarms: [],
    addSwarm: mockAddSwarm,
    updateSwarm: vi.fn(),
    refresh: vi.fn(),
  });
});

afterEach(() => cleanup());

describe("LaunchWorkflowButton", () => {
  it("renders the dialog closed initially", () => {
    render(<LaunchWorkflowButton orgSlug="acme" workspaceSlug="main" />);
    expect(screen.queryByTestId("launch-workflow-dialog-stub")).toBeNull();
  });

  it("clicking the button opens the dialog with the tenant slugs", () => {
    render(<LaunchWorkflowButton orgSlug="acme" workspaceSlug="main" />);
    fireEvent.click(screen.getByTestId("launch-workflow"));
    expect(
      screen.getByTestId("launch-workflow-dialog-stub").textContent,
    ).toContain("acme/main");
  });

  it("a launched swarm is forwarded to addSwarm", () => {
    render(<LaunchWorkflowButton orgSlug="acme" workspaceSlug="main" />);
    fireEvent.click(screen.getByTestId("launch-workflow"));
    fireEvent.click(screen.getByTestId("simulate-swarm-launched"));
    expect(mockAddSwarm).toHaveBeenCalledWith(
      expect.objectContaining({ swarmId: "s1", topic: "AI safety funding" }),
    );
  });
});
