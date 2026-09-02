// @vitest-environment jsdom
/**
 * ci-status-card.test.tsx
 *
 * Covers:
 *   - header ref + short sha (no decorative card-type chip)
 *   - delegates run roll-up to CiStatusSummary (overall status, counts, runs)
 *   - empty-runs graceful message
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import CiStatusCard, { type CiStatusCardProps } from "./ci-status-card";

afterEach(cleanup);

function props(overrides: Partial<CiStatusCardProps> = {}): CiStatusCardProps {
  return {
    ref: "main",
    sha: null,
    overall: "passing",
    counts: {
      total: 1,
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      neutral: 0,
    },
    runs: [
      {
        name: "build",
        status: "completed",
        conclusion: "success",
        url: "https://ci.example.com/1",
        startedAt: null,
        completedAt: null,
        durationMs: 12_000,
        app: "GitHub Actions",
      },
    ],
    ...overrides,
  };
}

describe("CiStatusCard", () => {
  it("renders the ref without a decorative ci-status chip", () => {
    render(<CiStatusCard {...props({ ref: "feat/x" })} />);
    expect(screen.getByText("feat/x")).toBeInTheDocument();
    // The static "ci-status" card-type label was removed — the ref is the header.
    expect(screen.queryByText("ci-status")).not.toBeInTheDocument();
  });

  it("renders the short sha when present", () => {
    render(<CiStatusCard {...props({ sha: "abcdef1234567890" })} />);
    expect(screen.getByText("(abcdef1)")).toBeInTheDocument();
  });

  it("renders the overall verdict status from the summary", () => {
    render(<CiStatusCard {...props({ overall: "failing" })} />);
    expect(screen.getByText("Failing")).toBeInTheDocument();
  });

  it("renders the run name via the embedded summary", () => {
    render(<CiStatusCard {...props()} />);
    expect(screen.getByText("build")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View build check" }),
    ).toBeInTheDocument();
  });

  it("shows the empty-state message when there are no runs", () => {
    render(
      <CiStatusCard
        {...props({
          overall: "unknown",
          counts: {
            total: 0,
            passed: 0,
            failed: 0,
            pending: 0,
            skipped: 0,
            neutral: 0,
          },
          runs: [],
        })}
      />,
    );
    expect(
      screen.getByText("No CI checks reported for this ref."),
    ).toBeInTheDocument();
  });

  it("exposes a data-component attribute for the registry", () => {
    const { container } = render(<CiStatusCard {...props()} />);
    expect(
      container.querySelector('[data-component="ci-status-card"]'),
    ).not.toBeNull();
  });
});
