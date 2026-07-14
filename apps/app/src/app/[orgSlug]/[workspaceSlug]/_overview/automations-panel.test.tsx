// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import type { AutomationListOutput } from "@oxagen/oxagen/contracts/automation.list";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@oxagen/handlers/register", () => ({}));

vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
}));

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@oxagen/oxagen", () => ({ invoke: mockInvoke }));

import { AutomationsPanel } from "./automations-panel";

const PROPS = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
  orgSlug: "acme",
  workspaceSlug: "prod",
};

function automation(
  overrides: Partial<AutomationListOutput[number]> = {},
): AutomationListOutput[number] {
  return {
    id: "auto_1",
    name: "Nightly digest",
    status: "active",
    triggerType: "schedule",
    triggers: ["cron:0 9 * * *"],
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AutomationsPanel", () => {
  it("renders status count chips and automation rows, capped at 5", async () => {
    const automations = Array.from({ length: 7 }, (_, i) =>
      automation({
        id: `auto_${i}`,
        name: `Automation ${i}`,
        status: i === 0 ? "paused" : "active",
      }),
    );
    mockInvoke.mockResolvedValue(automations);

    const element = await AutomationsPanel(PROPS);
    render(element);

    expect(
      screen.getByTestId("overview-automations-panel"),
    ).toBeInTheDocument();
    expect(screen.getByText("Automation 0")).toBeInTheDocument();
    expect(screen.getByText("Automation 4")).toBeInTheDocument();
    expect(screen.queryByText("Automation 5")).not.toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument(); // active count
    expect(screen.getByText("1")).toBeInTheDocument(); // paused count
    expect(screen.getByRole("link", { name: /view all/i })).toHaveAttribute(
      "href",
      "/acme/prod/automations",
    );
  });

  it("renders a zero-state inviting automation creation when there are none", async () => {
    mockInvoke.mockResolvedValue([]);

    const element = await AutomationsPanel(PROPS);
    render(element);

    expect(screen.getByText(/no automations yet/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /create an automation/i }),
    ).toHaveAttribute("href", "/acme/prod/automations");
  });

  it("renders a degraded error state when list_automations fails", async () => {
    mockInvoke.mockRejectedValue(new Error("db unavailable"));

    const element = await AutomationsPanel(PROPS);
    render(element);

    expect(screen.getByText(/automations unavailable/i)).toBeInTheDocument();
  });
});
