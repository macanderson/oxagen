// @vitest-environment jsdom
/**
 * sandbox-state-panel.test.tsx
 *
 * Covers the live State panel: the idle countdown-to-reap derived from
 * graceDeadlineAt, the dirty indicator, both recovery-banner states, and the
 * graceful "—" fallback when the extended fields are absent.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SandboxStatePanel } from "./sandbox-state-panel";
import type { SandboxSummary } from "@/lib/workbench/sandboxes";

afterEach(cleanup);

function summary(over: Partial<SandboxSummary> = {}): SandboxSummary {
  return {
    sessionId: "sbx_abc123def456",
    sessionKey: null,
    label: null,
    image: "agent",
    status: "running",
    driver: "modal",
    lastUsedAt: null,
    expiresAt: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    ...over,
  };
}

describe("SandboxStatePanel", () => {
  it("shows a live reap countdown for an idle session with a future deadline", () => {
    const deadline = new Date(Date.now() + 107_000).toISOString(); // ~1:47
    render(
      <SandboxStatePanel
        summary={summary({ status: "idle", graceDeadlineAt: deadline })}
      />,
    );
    expect(screen.getByTestId("sandbox-reap-countdown").textContent).toMatch(
      /reaping in \d+:\d{2}/,
    );
  });

  it("shows 'reaped' once the idle deadline has passed", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    render(
      <SandboxStatePanel
        summary={summary({ status: "idle", graceDeadlineAt: past })}
      />,
    );
    expect(screen.getByTestId("sandbox-reap-countdown").textContent).toBe(
      "reaped",
    );
  });

  it("falls back to — when not idle or missing a deadline", () => {
    render(<SandboxStatePanel summary={summary({ status: "running" })} />);
    expect(screen.getByTestId("sandbox-reap-countdown").textContent).toBe("—");
  });

  it("renders the dirty indicator only when dirty is true", () => {
    const { rerender } = render(
      <SandboxStatePanel summary={summary({ dirty: false })} />,
    );
    expect(screen.queryByTestId("sandbox-dirty-indicator")).toBeNull();
    rerender(<SandboxStatePanel summary={summary({ dirty: true })} />);
    expect(screen.getByTestId("sandbox-dirty-indicator")).toBeTruthy();
  });

  it("renders the recovered banner with the branch as a code chip", () => {
    render(
      <SandboxStatePanel
        summary={summary({
          recoveryStatus: "recovered",
          recoveryBranch: "recover/sbx-abc",
        })}
      />,
    );
    const banner = screen.getByTestId("sandbox-recovery-banner");
    expect(banner.getAttribute("data-recovery")).toBe("recovered");
    expect(screen.getByText("recover/sbx-abc").tagName).toBe("CODE");
  });

  it("renders the failed banner as a warning alert", () => {
    render(
      <SandboxStatePanel summary={summary({ recoveryStatus: "failed" })} />,
    );
    const banner = screen.getByTestId("sandbox-recovery-banner");
    expect(banner.getAttribute("data-recovery")).toBe("failed");
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toMatch(/manual attention needed/);
  });
});
