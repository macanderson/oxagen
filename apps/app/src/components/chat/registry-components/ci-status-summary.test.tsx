// @vitest-environment jsdom
/**
 * ci-status-summary.test.tsx
 *
 * Covers:
 *   - formatDuration: sub-minute "1.2s" vs mm:ss
 *   - overall status label per state (passing/failing/pending/neutral/unknown)
 *   - compact counts line omits zero categories
 *   - runs list renders per-run glyphs (success/failure/in-progress/skipped)
 *   - external links carry href + accessible label
 *   - empty runs renders no disclosure
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  CiStatusSummary,
  formatDuration,
  type CiCounts,
  type CiOverall,
  type CiRun,
} from "./ci-status-summary";

afterEach(cleanup);

const ZERO_COUNTS: CiCounts = {
  total: 0,
  passed: 0,
  failed: 0,
  pending: 0,
  skipped: 0,
  neutral: 0,
};

function run(overrides: Partial<CiRun>): CiRun {
  return {
    name: "build",
    status: "completed",
    conclusion: "success",
    url: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    app: null,
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("formats sub-minute durations as N.Ns", () => {
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(500)).toBe("0.5s");
  });

  it("formats a minute or more as mm:ss with padded seconds", () => {
    expect(formatDuration(60_000)).toBe("1:00");
    expect(formatDuration(90_000)).toBe("1:30");
    expect(formatDuration(605_000)).toBe("10:05");
  });

  it("clamps negative durations", () => {
    expect(formatDuration(-1)).toBe("0.0s");
  });
});

describe("CiStatusSummary overall status", () => {
  const cases: Array<[CiOverall, string, string]> = [
    ["passing", "Passing", "text-success"],
    ["failing", "Failing", "text-destructive"],
    ["pending", "Pending", "text-warning"],
    ["neutral", "Neutral", "text-muted-foreground"],
    ["unknown", "Unknown", "text-muted-foreground"],
  ];

  it.each(cases)(
    "renders %s -> %s label in the right tone",
    (overall, label, tone) => {
      render(
        <CiStatusSummary overall={overall} counts={ZERO_COUNTS} runs={[]} />,
      );
      const status = screen.getByText(label);
      expect(status).toBeInTheDocument();
      expect(status.className).toContain(tone);
    },
  );
});

describe("CiStatusSummary counts line", () => {
  it("omits zero categories", () => {
    render(
      <CiStatusSummary
        overall="failing"
        counts={{
          total: 8,
          passed: 5,
          failed: 1,
          pending: 2,
          skipped: 0,
          neutral: 0,
        }}
        runs={[]}
      />,
    );
    expect(
      screen.getByText("5 passed · 1 failed · 2 pending"),
    ).toBeInTheDocument();
  });

  it("renders nothing when every category is zero", () => {
    render(
      <CiStatusSummary overall="unknown" counts={ZERO_COUNTS} runs={[]} />,
    );
    expect(screen.queryByText(/passed/)).not.toBeInTheDocument();
  });
});

describe("CiStatusSummary runs list", () => {
  it("renders a glyph per run status and the run name", () => {
    render(
      <CiStatusSummary
        overall="failing"
        counts={{
          total: 4,
          passed: 1,
          failed: 1,
          pending: 1,
          skipped: 1,
          neutral: 0,
        }}
        runs={[
          run({ name: "unit", conclusion: "success" }),
          run({ name: "lint", conclusion: "failure" }),
          run({ name: "e2e", status: "in_progress", conclusion: null }),
          run({ name: "docs", conclusion: "skipped" }),
        ]}
      />,
    );
    expect(screen.getByText("unit")).toBeInTheDocument();
    expect(screen.getByLabelText("Success")).toBeInTheDocument();
    expect(screen.getByLabelText("Failure")).toBeInTheDocument();
    expect(screen.getByLabelText("In progress")).toBeInTheDocument();
    expect(screen.getByLabelText("Skipped")).toBeInTheDocument();
  });

  it("renders the app label and a formatted duration when present", () => {
    render(
      <CiStatusSummary
        overall="passing"
        counts={{
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          skipped: 0,
          neutral: 0,
        }}
        runs={[
          run({ name: "build", app: "GitHub Actions", durationMs: 90_000 }),
        ]}
      />,
    );
    expect(screen.getByText("GitHub Actions")).toBeInTheDocument();
    expect(screen.getByText("1:30")).toBeInTheDocument();
  });

  it("renders an external link with an accessible label when url is present", () => {
    render(
      <CiStatusSummary
        overall="passing"
        counts={{
          total: 1,
          passed: 1,
          failed: 0,
          pending: 0,
          skipped: 0,
          neutral: 0,
        }}
        runs={[run({ name: "build", url: "https://ci.example.com/1" })]}
      />,
    );
    const link = screen.getByRole("link", { name: "View build check" });
    expect(link).toHaveAttribute("href", "https://ci.example.com/1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders no runs disclosure when the list is empty", () => {
    render(
      <CiStatusSummary overall="unknown" counts={ZERO_COUNTS} runs={[]} />,
    );
    expect(screen.queryByText(/check$/)).not.toBeInTheDocument();
  });

  it("labels queued runs distinctly from in-progress runs", () => {
    render(
      <CiStatusSummary
        overall="pending"
        counts={{
          total: 1,
          passed: 0,
          failed: 0,
          pending: 1,
          skipped: 0,
          neutral: 0,
        }}
        runs={[run({ name: "deploy", status: "queued", conclusion: null })]}
      />,
    );
    expect(screen.getByLabelText("Queued")).toBeInTheDocument();
  });

  it("treats timed_out and cancelled as failure glyphs", () => {
    render(
      <CiStatusSummary
        overall="failing"
        counts={{
          total: 2,
          passed: 0,
          failed: 2,
          pending: 0,
          skipped: 0,
          neutral: 0,
        }}
        runs={[
          run({ name: "slow", conclusion: "timed_out" }),
          run({ name: "aborted", conclusion: "cancelled" }),
        ]}
      />,
    );
    expect(screen.getAllByLabelText("Failure")).toHaveLength(2);
  });

  it("shows a pending spinner in the overall status", () => {
    const { container } = render(
      <CiStatusSummary
        overall="pending"
        counts={{
          total: 1,
          passed: 0,
          failed: 0,
          pending: 1,
          skipped: 0,
          neutral: 0,
        }}
        runs={[]}
      />,
    );
    // Empty runs means the only spinner in the tree is the overall status's.
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});
