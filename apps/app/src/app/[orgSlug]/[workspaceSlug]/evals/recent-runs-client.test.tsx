// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * recent-runs-client.test.tsx — component tests for RecentRunsClient.
 *
 * Covers:
 *   (a) Empty state — no runs renders the "No eval runs yet" panel + still
 *       shows the header stat strip (all-time total).
 *   (b) Table render — one row per run; run cell links to the run detail
 *       route, dataset cell links to the dataset detail route.
 *   (c) Formatting — status Badge, avg score, cost (micros → USD), target
 *       ("Model: …" / "(default tier)" / "Agent: …").
 *   (d) Pass signal — avgScore ≥ threshold → "Pass"; below → "Below"; null
 *       score → "—".
 *   (e) Header stats — all-time total + avg-score-of-recent derived from the
 *       runs (nulls excluded).
 *
 * next/link renders a plain <a> under jsdom; @/lib/routes are pure builders —
 * neither is mocked.
 */

import { render, screen, within, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import type { EvalRunListOutput } from "@oxagen/oxagen/contracts/eval.run.list";
import { RecentRunsClient } from "./recent-runs-client";

type Run = EvalRunListOutput["runs"][number];

const BASE_RUN: Run = {
  runId: "evr_abc123def456ghi",
  datasetId: "evd_dataset1",
  datasetName: "Support triage",
  datasetSlug: "support-triage",
  name: "Nightly grade",
  target: { kind: "model", model: "claude-opus", agentSlug: null },
  judgeModel: "claude-sonnet",
  status: "completed",
  itemCount: 10,
  completedCount: 10,
  failedCount: 0,
  avgScore: 0.82,
  passThreshold: 0.7,
  costUsdMicros: 1_234_500,
  inputTokens: 1000,
  outputTokens: 500,
  createdAt: "2026-07-10T12:30:00.000Z",
  completedAt: "2026-07-10T12:35:00.000Z",
};

function makeRun(overrides: Partial<Run>): Run {
  return { ...BASE_RUN, ...overrides };
}

const PROPS = { orgSlug: "acme", workspaceSlug: "research" };

afterEach(() => cleanup());

describe("RecentRunsClient", () => {
  // ---------------------------------------------------------------------------
  // (a) Empty state
  // ---------------------------------------------------------------------------

  it("renders the empty state with header stats when there are no runs", () => {
    render(<RecentRunsClient runs={[]} allTimeTotal={0} {...PROPS} />);

    expect(screen.getByTestId("evals-recent-runs")).toBeInTheDocument();
    expect(
      screen.getByTestId("evals-recent-runs-empty-state"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/open a dataset and launch one/i),
    ).toBeInTheDocument();
    // Header stat strip still renders.
    expect(screen.getByText("Runs all-time")).toBeInTheDocument();
    expect(
      screen.queryByTestId("evals-recent-runs-table"),
    ).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (b) Table render + links
  // ---------------------------------------------------------------------------

  it("renders one row per run with run + dataset links to the correct routes", () => {
    const runs = [
      makeRun({ runId: "evr_one", name: "Run one", datasetId: "evd_one" }),
      makeRun({ runId: "evr_two", name: "Run two", datasetId: "evd_two" }),
    ];

    render(<RecentRunsClient runs={runs} allTimeTotal={2} {...PROPS} />);

    expect(screen.getByTestId("evals-recent-runs-table")).toBeInTheDocument();
    const rows = screen.getAllByTestId("evals-recent-run-row");
    expect(rows).toHaveLength(2);

    // Run link → run detail route.
    const runLink = screen.getByRole("link", { name: "Run one" });
    expect(runLink).toHaveAttribute(
      "href",
      "/acme/research/evals/runs/evr_one",
    );

    // Dataset link → dataset detail route.
    const datasetLinks = screen.getAllByRole("link", {
      name: "Support triage",
    });
    expect(datasetLinks[0]).toHaveAttribute(
      "href",
      "/acme/research/evals/datasets/evd_one",
    );
  });

  // ---------------------------------------------------------------------------
  // (c) Formatting
  // ---------------------------------------------------------------------------

  it("formats status, avg score, cost, and a model target", () => {
    render(
      <RecentRunsClient
        runs={[makeRun({ avgScore: 0.82, costUsdMicros: 1_234_500 })]}
        allTimeTotal={1}
        {...PROPS}
      />,
    );

    const row = screen.getByTestId("evals-recent-run-row");
    expect(within(row).getByText("completed")).toBeInTheDocument();
    expect(within(row).getByText("0.82")).toBeInTheDocument();
    expect(within(row).getByText("$1.2345")).toBeInTheDocument();
    expect(within(row).getByText("Model: claude-opus")).toBeInTheDocument();
    expect(within(row).getByText("10/10")).toBeInTheDocument();
  });

  it("formats a default-tier model target and an agent target", () => {
    const { rerender } = render(
      <RecentRunsClient
        runs={[
          makeRun({ target: { kind: "model", model: null, agentSlug: null } }),
        ]}
        allTimeTotal={1}
        {...PROPS}
      />,
    );
    expect(screen.getByText("Model: (default tier)")).toBeInTheDocument();

    rerender(
      <RecentRunsClient
        runs={[
          makeRun({
            target: { kind: "agent", model: null, agentSlug: "triage-bot" },
          }),
        ]}
        allTimeTotal={1}
        {...PROPS}
      />,
    );
    expect(screen.getByText("Agent: triage-bot")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (d) Pass signal
  // ---------------------------------------------------------------------------

  it("shows Pass when avg score meets the threshold and Below when it does not", () => {
    const { rerender } = render(
      <RecentRunsClient
        runs={[makeRun({ avgScore: 0.9, passThreshold: 0.7 })]}
        allTimeTotal={1}
        {...PROPS}
      />,
    );
    expect(
      within(screen.getByTestId("evals-recent-run-row")).getByText("Pass"),
    ).toBeInTheDocument();

    rerender(
      <RecentRunsClient
        runs={[makeRun({ avgScore: 0.5, passThreshold: 0.7 })]}
        allTimeTotal={1}
        {...PROPS}
      />,
    );
    expect(
      within(screen.getByTestId("evals-recent-run-row")).getByText("Below"),
    ).toBeInTheDocument();
  });

  it("shows a dash for pass and score when avgScore is null", () => {
    render(
      <RecentRunsClient
        runs={[makeRun({ avgScore: null })]}
        allTimeTotal={1}
        {...PROPS}
      />,
    );
    const row = screen.getByTestId("evals-recent-run-row");
    // Two dashes: avg score cell + pass cell.
    expect(within(row).getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(within(row).queryByText("Pass")).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (e) Header stats
  // ---------------------------------------------------------------------------

  it("renders the all-time total and averages recent scores (nulls excluded)", () => {
    const runs = [
      makeRun({ runId: "r1", avgScore: 0.8 }),
      makeRun({ runId: "r2", avgScore: 0.6 }),
      makeRun({ runId: "r3", avgScore: null }),
    ];

    render(<RecentRunsClient runs={runs} allTimeTotal={42} {...PROPS} />);

    // All-time total from the RSC.
    expect(screen.getByText("42")).toBeInTheDocument();
    // Avg of 0.8 and 0.6 (0 excluded) = 0.70.
    expect(screen.getByText("0.70")).toBeInTheDocument();
  });
});
