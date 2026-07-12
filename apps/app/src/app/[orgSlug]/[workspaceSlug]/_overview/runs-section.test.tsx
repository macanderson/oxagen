// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { AgentExecutionListOutput } from "@oxagen/oxagen/contracts/agent.execution.list";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
}));

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));

import { RunsTile } from "./runs-section";

const PROPS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "prod",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RunsTile", () => {
  it("renders recent runs with status, origin, duration, cost, and a link to the run", async () => {
    const output: AgentExecutionListOutput = {
      executions: [
        {
          executionId: "aex_1",
          status: "completed",
          originType: "ask",
          originId: "conv_1",
          agentId: null,
          startedAt: "2026-07-12T10:00:00.000Z",
          completedAt: "2026-07-12T10:00:05.000Z",
          latencyMs: 5000,
          inputTokens: 100,
          outputTokens: 50,
          estimatedCostUsd: "0.0120",
          createdAt: "2026-07-12T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    mockInvoke.mockResolvedValue(output);

    const element = await RunsTile(PROPS);
    render(element);

    expect(screen.getByTestId("overview-runs-tile")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("ask")).toBeInTheDocument();
    const runLink = screen.getByRole("link", { name: /completed ask/i });
    expect(runLink).toHaveAttribute("href", "/acme/prod/activity/aex_1");
    expect(screen.getByRole("link", { name: /view all runs/i })).toHaveAttribute(
      "href",
      "/acme/prod/activity",
    );
  });

  it("renders a zero-state inviting the first Ask when there are no runs", async () => {
    mockInvoke.mockResolvedValue({ executions: [], nextCursor: null });

    const element = await RunsTile(PROPS);
    render(element);

    expect(screen.getByText(/no runs yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open ask/i })).toHaveAttribute(
      "href",
      "/acme/prod/ask",
    );
  });

  it("renders a degraded error state when list_executions fails", async () => {
    mockInvoke.mockRejectedValue(new Error("db unavailable"));

    const element = await RunsTile(PROPS);
    render(element);

    expect(screen.getByText(/runs unavailable/i)).toBeInTheDocument();
  });
});
