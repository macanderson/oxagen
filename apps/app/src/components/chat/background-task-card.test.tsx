// @vitest-environment jsdom
/**
 * background-task-card.test.tsx — verifies the live + persisted card surface
 * for the OXA-1469 background-task-progress event:
 *   - Renders the kind / label / status badge for each lifecycle phase.
 *   - Shows a progress bar only while running AND when progressPct is known.
 *   - Carries the taskId + status as data-attrs the e2e test reads.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BackgroundTaskCard } from "./background-task-card";

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

afterEach(cleanup);

describe("BackgroundTaskCard", () => {
  it("renders the label when provided, otherwise the raw kind", () => {
    render(
      <BackgroundTaskCard taskId="t-1" kind="ingest_graph" status="pending" label="Ingest large doc" />,
    );
    expect(screen.getByText("Ingest large doc")).toBeTruthy();
    expect(screen.getByText("ingest_graph")).toBeTruthy();
  });

  it("falls back to the kind when no label is set", () => {
    render(<BackgroundTaskCard taskId="t-1" kind="ingest_graph" status="pending" />);
    expect(screen.getAllByText("ingest_graph").length).toBeGreaterThan(0);
  });

  it("surfaces the status as a data attribute and a human label", () => {
    const { container } = render(
      <BackgroundTaskCard taskId="t-7" kind="agent.task" status="running" />,
    );
    const card = container.querySelector('[data-component="background-task-card"]');
    expect(card?.getAttribute("data-status")).toBe("running");
    expect(card?.getAttribute("data-task-id")).toBe("t-7");
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("renders a progress bar only while running AND when progressPct is known", () => {
    const { rerender, container } = render(
      <BackgroundTaskCard taskId="t-1" kind="agent.task" status="running" />,
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    rerender(
      <BackgroundTaskCard taskId="t-1" kind="agent.task" status="running" progressPct={42} />,
    );
    const bar = container.querySelector('[role="progressbar"]');
    expect(bar).toBeTruthy();
    expect(bar?.getAttribute("aria-valuenow")).toBe("42");
  });

  it("renders no progress bar in terminal states even when progressPct is provided", () => {
    const { container } = render(
      <BackgroundTaskCard taskId="t-1" kind="agent.task" status="completed" progressPct={100} />,
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("clamps progressPct into 0–100 for the bar width", () => {
    const { container } = render(
      <BackgroundTaskCard taskId="t-1" kind="agent.task" status="running" progressPct={250} />,
    );
    const fill = container.querySelector('[role="progressbar"] > div') as HTMLDivElement | null;
    expect(fill?.style.width).toBe("100%");
  });
});
