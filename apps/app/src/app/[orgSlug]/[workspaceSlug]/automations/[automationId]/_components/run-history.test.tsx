// @vitest-environment jsdom
/**
 * run-history.test.tsx — unit tests for the automation's read-only run
 * history table, including the pure formatWhen/formatDuration/statusVariant
 * helpers (exercised through rendered output since they're module-private).
 * Pure presentational component (no client hooks, no mocks needed).
 *
 * Covers:
 *   - "Never fired" empty state when there are no runs.
 *   - A row's Started cell matches `new Date(iso).toLocaleString()` (computed
 *     in-test rather than hardcoded, so it's locale/TZ independent) — proves
 *     formatWhen prefers startedAt and falls through to createdAt.
 *   - An invalid/garbage ISO string renders "—" (NaN-date guard).
 *   - formatDuration: sub-second durations render in ms, second+ durations
 *     round to one decimal in s, a null endpoint or a negative duration
 *     (completedAt before startedAt) renders "—".
 *   - Each status renders its own soft-badge color class (statusVariant's
 *     full switch, including the "unknown status" default branch).
 */
import { render, screen, cleanup, within } from "@testing-library/react";
import { describe, it, expect, afterEach } from "vitest";
import { RunHistory } from "./run-history";
import type { AutomationGetOutput } from "@oxagen/oxagen/contracts/automation.get";

type Run = AutomationGetOutput["runs"][number];

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run_1",
    status: "completed",
    source: "manual",
    startedAt: "2026-07-01T00:00:00.000Z",
    completedAt: "2026-07-01T00:05:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("RunHistory — empty state", () => {
  it("shows 'Never fired' copy when there are no runs", () => {
    render(<RunHistory runs={[]} />);
    expect(screen.getByText(/Never fired/i)).toBeTruthy();
    expect(screen.queryByTestId("run-history-table")).toBeNull();
  });
});

describe("RunHistory — Started column", () => {
  it("prefers startedAt and renders the locale-formatted timestamp", () => {
    render(
      <RunHistory runs={[run({ startedAt: "2026-07-01T12:30:00.000Z" })]} />,
    );
    const expected = new Date("2026-07-01T12:30:00.000Z").toLocaleString();
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("falls back to createdAt when startedAt is null", () => {
    render(
      <RunHistory
        runs={[run({ startedAt: null, createdAt: "2026-07-02T00:00:00.000Z" })]}
      />,
    );
    const expected = new Date("2026-07-02T00:00:00.000Z").toLocaleString();
    expect(screen.getByText(expected)).toBeTruthy();
  });

  it("renders a dash for an invalid ISO string", () => {
    render(
      <RunHistory
        runs={[run({ startedAt: "not-a-date", createdAt: "not-a-date" })]}
      />,
    );
    const row = screen
      .getByTestId("run-history-table")
      .querySelector("tbody tr");
    expect(row?.textContent).toContain("—");
  });
});

describe("RunHistory — Duration column", () => {
  it("renders sub-second durations in ms", () => {
    render(
      <RunHistory
        runs={[
          run({
            startedAt: "2026-07-01T00:00:00.000Z",
            completedAt: "2026-07-01T00:00:00.500Z",
          }),
        ]}
      />,
    );
    expect(screen.getByText("500ms")).toBeTruthy();
  });

  it("renders second+ durations rounded to one decimal", () => {
    render(
      <RunHistory
        runs={[
          run({
            startedAt: "2026-07-01T00:00:00.000Z",
            completedAt: "2026-07-01T00:00:01.500Z",
          }),
        ]}
      />,
    );
    expect(screen.getByText("1.5s")).toBeTruthy();
  });

  it("renders a dash when either endpoint is null", () => {
    render(<RunHistory runs={[run({ completedAt: null })]} />);
    const row = screen
      .getByTestId("run-history-table")
      .querySelector("tbody tr");
    expect(within(row as HTMLElement).getAllByText("—").length).toBeGreaterThan(
      0,
    );
  });

  it("renders a dash for a negative duration (completedAt before startedAt)", () => {
    render(
      <RunHistory
        runs={[
          run({
            startedAt: "2026-07-01T00:05:00.000Z",
            completedAt: "2026-07-01T00:00:00.000Z",
          }),
        ]}
      />,
    );
    const row = screen
      .getByTestId("run-history-table")
      .querySelector("tbody tr");
    expect(within(row as HTMLElement).getAllByText("—").length).toBeGreaterThan(
      0,
    );
  });
});

describe("RunHistory — status badge coloring", () => {
  it.each([
    ["completed", "text-success"],
    ["failed", "text-error"],
    ["cancelled", "text-muted-foreground"],
    ["running", "text-info"],
    ["pending", "text-info"],
    ["waiting_approval", "text-warning"],
    ["paused", "text-warning"],
    ["some_unknown_status", "text-muted-foreground"],
  ])("status=%s gets the %s badge class", (status, expectedClassFragment) => {
    render(<RunHistory runs={[run({ status })]} />);
    const badge = screen.getByText(status);
    expect(badge.className).toContain(expectedClassFragment);
  });
});
