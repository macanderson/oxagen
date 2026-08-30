// @vitest-environment jsdom
/**
 * tool-activity-group.test.tsx
 *
 * The compact, calm redesign of the tool-call UX:
 *   - Collapsed by default, always (no rows until the user expands)
 *   - Live line names the LATEST call + a "step N" counter (the "working" signal)
 *   - Finished line is a single muted summary; failures read as a muted "issue",
 *     never destructive-red, and no risk badge appears anywhere
 *   - Expanding lists one-line rows; opening a row reveals the headerless
 *     ToolCallCard detail body (keeping its e2e test id)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ToolActivityGroup,
  type ToolActivityItem,
} from "./tool-activity-group";

afterEach(cleanup);

// Stub the detail body so the test doesn't need the full structured-value tree
// (and its ResizeObserver dependency). Keep the real formatDuration.
vi.mock("./tool-call-card", async (importOriginal) => {
  const real = await importOriginal<typeof import("./tool-call-card")>();
  return {
    ...real,
    ToolCallCard: ({
      toolCallId,
      hideHeader,
    }: {
      toolCallId: string;
      hideHeader?: boolean;
    }) => (
      <div
        data-testid={`tool-call-card-${toolCallId}`}
        data-hide-header={String(!!hideHeader)}
      />
    ),
  };
});

function item(over: Partial<ToolActivityItem> = {}): ToolActivityItem {
  return {
    toolCallId: "t1",
    capability: "search_web",
    inputPreview: { query: "submarines" },
    riskLevel: "low",
    status: "completed",
    durationMs: 1500,
    ...over,
  };
}

describe("ToolActivityGroup", () => {
  it("renders nothing for an empty run", () => {
    const { container } = render(<ToolActivityGroup items={[]} live={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("is collapsed by default — no rows are shown", () => {
    render(<ToolActivityGroup items={[item()]} live={false} />);
    expect(screen.getByTestId("tool-activity-group")).toBeInTheDocument();
    expect(
      screen.queryByTestId("tool-activity-row-t1"),
    ).not.toBeInTheDocument();
  });

  it("shows a single finished summary line with count, duration and the last call", () => {
    render(
      <ToolActivityGroup
        items={[
          item({ toolCallId: "t1", durationMs: 1500 }),
          item({
            toolCallId: "t2",
            capability: "fetch_web_page",
            inputPreview: { url: "https://x.com" },
            durationMs: 1500,
          }),
        ]}
        live={false}
      />,
    );
    const group = screen.getByTestId("tool-activity-group");
    expect(within(group).getByLabelText("Done")).toBeInTheDocument();
    expect(group.textContent).toContain("2 tool calls");
    expect(group.textContent).toContain("3.0s"); // 1500 + 1500 summed
    expect(group.textContent).toContain("Fetch web page"); // label of the last call
  });

  it("uses the singular noun for a single call", () => {
    render(<ToolActivityGroup items={[item()]} live={false} />);
    const text = screen.getByTestId("tool-activity-group").textContent ?? "";
    expect(text).toContain("1 tool call");
    expect(text).not.toContain("tool calls");
  });

  it("reads a failure as a muted 'issue', never destructive-red", () => {
    render(
      <ToolActivityGroup items={[item({ status: "failed" })]} live={false} />,
    );
    const group = screen.getByTestId("tool-activity-group");
    expect(group.textContent).toContain("1 issue");
    // No red anywhere on the calm summary line.
    expect(group.querySelector(".text-destructive")).toBeNull();
  });

  it("never renders a risk badge", () => {
    render(
      <ToolActivityGroup items={[item({ riskLevel: "high" })]} live={false} />,
    );
    expect(screen.queryByText(/^(low|medium|high)$/i)).not.toBeInTheDocument();
  });

  it("shows the LIVE line naming the latest call plus a step counter while streaming", () => {
    render(
      <ToolActivityGroup
        items={[
          item({ toolCallId: "t1", status: "completed" }),
          item({
            toolCallId: "t2",
            capability: "fetch_web_page",
            inputPreview: { url: "https://y.com" },
            status: "running",
          }),
        ]}
        live={true}
      />,
    );
    const group = screen.getByTestId("tool-activity-group");
    // The spinner is the "agent is working, not hung" signal.
    expect(within(group).getByLabelText("Working")).toBeInTheDocument();
    // Latest (running) call is named.
    expect(group.textContent).toContain("Fetch web page");
    // Counter reflects the run length.
    expect(group.textContent).toContain("step 2");
  });

  it("shows the finished (Done) line when live but nothing is in-flight", () => {
    render(
      <ToolActivityGroup items={[item({ status: "completed" })]} live={true} />,
    );
    const group = screen.getByTestId("tool-activity-group");
    expect(within(group).getByLabelText("Done")).toBeInTheDocument();
    expect(within(group).queryByLabelText("Working")).not.toBeInTheDocument();
  });

  it("expands into one-line rows on click", async () => {
    render(
      <ToolActivityGroup
        items={[
          item({ toolCallId: "t1" }),
          item({ toolCallId: "t2", capability: "fetch_web_page" }),
        ]}
        live={false}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /expand tool activity/i }),
    );
    expect(screen.getByTestId("tool-activity-row-t1")).toBeInTheDocument();
    expect(screen.getByTestId("tool-activity-row-t2")).toBeInTheDocument();
    // Detail bodies are not opened just by expanding the group.
    expect(screen.queryByTestId("tool-call-card-t1")).not.toBeInTheDocument();
  });

  it("opens the headerless ToolCallCard detail body when a row is clicked", async () => {
    render(
      <ToolActivityGroup items={[item({ toolCallId: "t1" })]} live={false} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /expand tool activity/i }),
    );
    const row = screen.getByTestId("tool-activity-row-t1");
    await userEvent.click(within(row).getByRole("button"));
    const detail = screen.getByTestId("tool-call-card-t1");
    expect(detail).toBeInTheDocument();
    expect(detail).toHaveAttribute("data-hide-header", "true");
  });

  it("shows a muted 'failed' word on a failed row (not destructive-red)", async () => {
    render(
      <ToolActivityGroup
        items={[item({ toolCallId: "t1", status: "failed" })]}
        live={false}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /expand tool activity/i }),
    );
    const row = screen.getByTestId("tool-activity-row-t1");
    expect(row.textContent).toContain("failed");
    expect(row.querySelector(".text-destructive")).toBeNull();
  });
});
