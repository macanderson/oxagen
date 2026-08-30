// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import ResearchSwarmCard from "./research-swarm-card";

// TruncatedText (the per-hit snippet) measures scroll overflow via
// ResizeObserver, which isn't implemented in JSDOM.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ResearchSwarmCard", () => {
  it("shows a running progress indicator from completed/total tasks", () => {
    render(
      <ResearchSwarmCard
        output={{
          swarmId: "swm_1",
          dispatchId: "fan_1",
          status: "running",
          completedTasks: 3,
          totalTasks: 15,
        }}
      />,
    );
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("3 / 15 tasks")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("20");
    expect(screen.getByText("swm_1")).toBeTruthy();
  });

  it("renders a complete swarm with per-query hits as clickable links", () => {
    render(
      <ResearchSwarmCard
        output={{
          swarmId: "swm_2",
          status: "complete",
          completedTasks: 2,
          totalTasks: 2,
          results: [
            {
              query: "USS Nautilus crew",
              resultCount: 5,
              hits: [
                {
                  title: "Crew roster",
                  url: "https://example.com/crew",
                  snippet: "The crew…",
                },
              ],
            },
            { query: "Nautilus Arctic voyage", resultCount: 3, hits: [] },
          ],
        }}
      />,
    );
    expect(screen.getByText("Complete")).toBeTruthy();
    expect(screen.getByText("USS Nautilus crew")).toBeTruthy();
    expect(screen.getByText("5 results")).toBeTruthy();
    // The actual hit renders as an external link (the reachable data, finally).
    const link = screen.getByText("Crew roster").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/crew");
    expect(link?.getAttribute("target")).toBe("_blank");
    // The hit snippet is now shown as visible text (via TruncatedText), not
    // hidden away in a hover-only title attribute.
    expect(screen.getByText("The crew…")).toBeTruthy();
  });

  it("renders a failed swarm", () => {
    render(
      <ResearchSwarmCard
        output={{ status: "failed", completedTasks: 0, totalTasks: 4 }}
      />,
    );
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("does not poll when tenant slugs are absent (static render)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ResearchSwarmCard
        output={{
          swarmId: "swm_x",
          status: "running",
          completedTasks: 0,
          totalTasks: 5,
        }}
      />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not poll when the initial snapshot is already terminal", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ResearchSwarmCard
        orgSlug="acme"
        workspaceSlug="main"
        output={{
          swarmId: "swm_done",
          status: "complete",
          completedTasks: 5,
          totalTasks: 5,
          results: [],
        }}
      />,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("polls research.swarm.status and updates to complete with live results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        swarmId: "swm_live",
        status: "complete",
        completedTasks: 2,
        totalTasks: 2,
        results: [
          {
            query: "USS Nautilus reactor",
            resultCount: 1,
            hits: [
              {
                title: "S2W reactor",
                url: "https://example.com/s2w",
                snippet: "The reactor…",
              },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // Initial render reflects the fire-and-forget start output: running, 0%.
    render(
      <ResearchSwarmCard
        orgSlug="acme"
        workspaceSlug="main"
        output={{
          swarmId: "swm_live",
          status: "running",
          completedTasks: 0,
          totalTasks: 2,
        }}
      />,
    );
    expect(screen.getByText("Running")).toBeTruthy();

    // After the first poll the card reflects live status + results.
    await waitFor(() => expect(screen.getByText("Complete")).toBeTruthy());
    expect(screen.getByText("USS Nautilus reactor")).toBeTruthy();
    const link = screen.getByText("S2W reactor").closest("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/s2w");

    // The poll hit the org+workspace-scoped status route with the swarm id.
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/acme/main/research/swarm/status?swarmId=swm_live",
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
});
