// @vitest-environment jsdom
/**
 * coding-trace-panel.test.tsx
 *
 * Covers:
 *   - Empty state ("No steps.")
 *   - Renders both a terminal step (delegates to TerminalTraceCard) and a
 *     diff step (delegates to CodeDiffCard) without re-implementing either
 *   - Summary shows step count + total duration
 *   - Collapse toggle shows/hides step bodies
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CodingTracePanel from "./coding-trace-panel";

afterEach(cleanup);

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => (
    <div role="tablist">{children}</div>
  ),
  TabsTab: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => (
    <button role="tab" data-value={value} type="button">
      {children}
    </button>
  ),
  TabsPanel: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => (
    <div role="tabpanel" data-value={value}>
      {children}
    </div>
  ),
}));

vi.mock("../tool-call-card", () => ({
  formatDuration: (ms: number) => `${Math.round(ms / 1000)}s`,
}));

const SAMPLE_PATCH = ["@@ -1,1 +1,1 @@", "-old", "+new"].join("\n");

describe("CodingTracePanel", () => {
  it("renders the empty state when there are no steps", () => {
    render(<CodingTracePanel steps={[]} />);
    expect(screen.getByText("No steps.")).toBeInTheDocument();
  });

  it("shows the step count and total duration in the header", () => {
    render(
      <CodingTracePanel
        steps={[
          {
            kind: "terminal",
            durationMs: 2000,
            terminal: { stdout: "ok", exitCode: 0 },
          },
          {
            kind: "diff",
            durationMs: 3000,
            diff: { files: [{ path: "a.ts", patch: SAMPLE_PATCH }] },
          },
        ]}
      />,
    );
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(screen.getByText("5s")).toBeInTheDocument();
  });

  it("is collapsed by default and expands to reveal step bodies, delegating to the child cards", async () => {
    render(
      <CodingTracePanel
        title="Run overview"
        steps={[
          {
            kind: "terminal",
            title: "Run tests",
            status: "success",
            terminal: { stdout: "all good", exitCode: 0 },
          },
          {
            kind: "diff",
            title: "Apply patch",
            status: "success",
            diff: { files: [{ path: "src/a.ts", patch: SAMPLE_PATCH }] },
          },
        ]}
      />,
    );

    const toggle = screen.getByRole("button", { name: /Run overview/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      document.querySelector("[data-component='terminal-trace-card']"),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector("[data-component='code-diff-card']"),
    ).not.toBeInTheDocument();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      document.querySelector("[data-component='terminal-trace-card']"),
    ).toBeInTheDocument();
    expect(
      document.querySelector("[data-component='code-diff-card']"),
    ).toBeInTheDocument();
    expect(screen.getByText("Run tests")).toBeInTheDocument();
    expect(screen.getByText("Apply patch")).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      document.querySelector("[data-component='terminal-trace-card']"),
    ).not.toBeInTheDocument();
  });

  it("has the coding-trace-panel data-component attribute", () => {
    render(
      <CodingTracePanel
        steps={[{ kind: "terminal", terminal: { stdout: "x" } }]}
      />,
    );
    expect(
      document.querySelector("[data-component='coding-trace-panel']"),
    ).toBeInTheDocument();
  });
});
