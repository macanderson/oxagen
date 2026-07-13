// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * runs-table.test.tsx — component tests for the server-driven RunsTable.
 *
 * The table drives ALL sort / paginate / date-filter server-side: any control
 * change calls listEvalRunsAction with the mapped query and swaps the rows.
 * These tests mock ../../actions and assert the exact query shape passed on
 * each interaction, plus that the seeded first page renders WITHOUT a fetch on
 * mount (props already are the today/created/desc/page-1 result).
 *
 * Covers:
 *   (a) Seeds initial rows from props; NO action call on mount.
 *   (b) Count line — "Showing N of {total} — {allTimeTotal} all-time".
 *   (c) Date preset (7d) → refetch with a since 6 days back, offset 0.
 *   (d) "All" preset → refetch with NO since.
 *   (e) Sort by Score → sortBy:"score", sortDir:"desc"; clicking again toggles
 *       sortDir to "asc".
 *   (f) Pagination Next → offset advances by the page size.
 *   (g) Each row links to the run detail route.
 */

import * as React from "react";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  within,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EvalRunListOutput } from "@oxagen/oxagen/contracts/eval.run.list";
import { workspace } from "@/lib/routes";

const { mockListEvalRunsAction } = vi.hoisted(() => ({
  mockListEvalRunsAction: vi.fn(),
}));

vi.mock("../../../actions", () => ({
  listEvalRunsAction: (...args: unknown[]) => mockListEvalRunsAction(...args),
}));

import { RunsTable } from "../runs-table";

type RunRow = EvalRunListOutput["runs"][number];

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    runId: "evr_1",
    datasetId: "evd_1",
    datasetName: "Smoke",
    datasetSlug: "smoke",
    name: "Nightly",
    target: { kind: "model", model: "openai/gpt-4o", agentSlug: null },
    judgeModel: "anthropic/claude-sonnet",
    status: "completed",
    itemCount: 10,
    completedCount: 10,
    failedCount: 0,
    avgScore: 0.82,
    passThreshold: 0.7,
    costUsdMicros: 12_345,
    inputTokens: 100,
    outputTokens: 50,
    createdAt: "2026-07-12T10:00:00.000Z",
    completedAt: "2026-07-12T10:05:00.000Z",
    ...overrides,
  };
}

const BASE_PROPS = {
  orgSlug: "acme",
  workspaceSlug: "research",
  datasetPublicId: "evd_1",
  initialSince: "2026-07-12T00:00:00.000Z",
};

/** Build a fresh listEvalRunsAction result. */
function result(
  runs: RunRow[],
  total: number,
  allTimeTotal: number,
): { ok: true; data: EvalRunListOutput } {
  return { ok: true, data: { runs, total, allTimeTotal } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListEvalRunsAction.mockResolvedValue(result([run()], 1, 1));
});

afterEach(() => cleanup());

describe("RunsTable — seeding", () => {
  it("renders the seeded first page and does NOT call the action on mount", () => {
    render(
      <RunsTable
        {...BASE_PROPS}
        initialRuns={[run({ runId: "evr_seed", name: "Seeded run" })]}
        initialTotal={1}
        initialAllTimeTotal={7}
      />,
    );
    expect(screen.getByText("Seeded run")).toBeInTheDocument();
    expect(mockListEvalRunsAction).not.toHaveBeenCalled();
  });

  it("shows the count line: Showing N of {total} — {allTimeTotal} all-time", () => {
    render(
      <RunsTable
        {...BASE_PROPS}
        initialRuns={[run()]}
        initialTotal={3}
        initialAllTimeTotal={42}
      />,
    );
    expect(screen.getByTestId("evals-runs-count")).toHaveTextContent(
      /Showing 1.*of 3.*42 all-time/,
    );
  });
});

describe("RunsTable — date filter (server-driven)", () => {
  it("switching to 7d refetches with a since 6 days back and offset 0", async () => {
    render(
      <RunsTable
        {...BASE_PROPS}
        initialRuns={[run()]}
        initialTotal={1}
        initialAllTimeTotal={1}
      />,
    );

    fireEvent.click(screen.getByTestId("evals-runs-range-7d"));

    await waitFor(() => expect(mockListEvalRunsAction).toHaveBeenCalledOnce());
    const arg = mockListEvalRunsAction.mock.calls[0][0];
    expect(arg).toMatchObject({
      orgSlug: "acme",
      workspaceSlug: "research",
      datasetPublicId: "evd_1",
      sortBy: "created",
      sortDir: "desc",
      limit: 25,
      offset: 0,
    });
    // since is 6 UTC-days before today's UTC midnight.
    expect(typeof arg.since).toBe("string");
    const sinceMs = Date.parse(arg.since);
    const now = new Date();
    const todayUtc = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    expect(sinceMs).toBe(todayUtc - 6 * 86_400_000);
  });

  it("switching to All refetches with NO since", async () => {
    render(
      <RunsTable
        {...BASE_PROPS}
        initialRuns={[run()]}
        initialTotal={1}
        initialAllTimeTotal={1}
      />,
    );

    fireEvent.click(screen.getByTestId("evals-runs-range-all"));

    await waitFor(() => expect(mockListEvalRunsAction).toHaveBeenCalledOnce());
    const arg = mockListEvalRunsAction.mock.calls[0][0];
    expect(arg.since).toBeUndefined();
  });
});

describe("RunsTable — sorting (server-driven)", () => {
  it("clicking Score sorts by score desc, then toggles to asc", async () => {
    render(
      <RunsTable
        {...BASE_PROPS}
        initialRuns={[run()]}
        initialTotal={1}
        initialAllTimeTotal={1}
      />,
    );

    fireEvent.click(screen.getByTestId("evals-runs-sort-score"));
    await waitFor(() =>
      expect(mockListEvalRunsAction).toHaveBeenCalledTimes(1),
    );
    expect(mockListEvalRunsAction.mock.calls[0][0]).toMatchObject({
      sortBy: "score",
      sortDir: "desc",
    });

    fireEvent.click(screen.getByTestId("evals-runs-sort-score"));
    await waitFor(() =>
      expect(mockListEvalRunsAction).toHaveBeenCalledTimes(2),
    );
    expect(mockListEvalRunsAction.mock.calls[1][0]).toMatchObject({
      sortBy: "score",
      sortDir: "asc",
    });
  });

  it("clicking Model sorts by model desc", async () => {
    render(
      <RunsTable
        {...BASE_PROPS}
        initialRuns={[run()]}
        initialTotal={1}
        initialAllTimeTotal={1}
      />,
    );
    fireEvent.click(screen.getByTestId("evals-runs-sort-model"));
    await waitFor(() => expect(mockListEvalRunsAction).toHaveBeenCalledOnce());
    expect(mockListEvalRunsAction.mock.calls[0][0]).toMatchObject({
      sortBy: "model",
      sortDir: "desc",
    });
  });
});

describe("RunsTable — pagination (server-driven)", () => {
  it("Next advances the offset by the page size", async () => {
    // total 60 → 3 pages of 25 → Next is enabled.
    render(
      <RunsTable
        {...BASE_PROPS}
        initialRuns={[run()]}
        initialTotal={60}
        initialAllTimeTotal={60}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));

    await waitFor(() => expect(mockListEvalRunsAction).toHaveBeenCalledOnce());
    expect(mockListEvalRunsAction.mock.calls[0][0]).toMatchObject({
      limit: 25,
      offset: 25,
    });
  });
});

describe("RunsTable — row link", () => {
  it("links each row to the run detail route", () => {
    render(
      <RunsTable
        {...BASE_PROPS}
        initialRuns={[run({ runId: "evr_link", name: "Linked run" })]}
        initialTotal={1}
        initialAllTimeTotal={1}
      />,
    );
    const row = screen.getByTestId("evals-runs-row");
    const link = within(row).getByRole("link", { name: "Linked run" });
    expect(link.getAttribute("href")).toBe(
      workspace.evals.run(
        { orgSlug: "acme", workspaceSlug: "research" },
        "evr_link",
      ),
    );
  });
});
