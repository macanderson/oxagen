// @vitest-environment jsdom
/**
 * spend-budgets-panel.test.tsx — component tests for SpendBudgetsPanel.
 *
 * ScopeBudgetCard is mocked to a minimal stand-in so this file tests only the
 * orchestrator's own responsibility: always rendering BOTH scopes (even when
 * initialBudgets has zero or one entry) and routing a save callback to the
 * correct scope's slot in local state without disturbing the other scope.
 */
import * as React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import type {
  SpendBudgetScope,
  SpendBudgetStatus,
} from "./spend-budget-format";

vi.mock("./scope-budget-card", () => ({
  ScopeBudgetCard: ({
    scope,
    budget,
    canManage,
    onSaved,
  }: {
    scope: SpendBudgetScope;
    budget: SpendBudgetStatus | null;
    canManage: boolean;
    onSaved: (scope: SpendBudgetScope, budget: SpendBudgetStatus) => void;
  }) => (
    <div data-testid={`mock-card-${scope}`}>
      <span data-testid={`mock-card-${scope}-limit`}>
        {budget?.limitUsd ?? "empty"}
      </span>
      <span data-testid={`mock-card-${scope}-can-manage`}>
        {String(canManage)}
      </span>
      <button
        type="button"
        onClick={() =>
          onSaved(scope, {
            scope,
            publicId: `bdg_${scope}`,
            enabled: true,
            period: "monthly",
            windowDays: null,
            limitUsd: 999,
            spentUsd: 0,
            projectedUsd: 0,
            ratio: 0,
            state: "ok",
            reachedThreshold: 0,
            windowStart: "2026-07-01T00:00:00.000Z",
            windowEnd: "2026-07-21T00:00:00.000Z",
          })
        }
      >
        save-{scope}
      </button>
    </div>
  ),
}));

import { SpendBudgetsPanel } from "./spend-budgets-panel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function budget(scope: SpendBudgetScope, limitUsd: number): SpendBudgetStatus {
  return {
    scope,
    publicId: `bdg_${scope}`,
    enabled: true,
    period: "monthly",
    windowDays: null,
    limitUsd,
    spentUsd: 0,
    projectedUsd: 0,
    ratio: 0,
    state: "ok",
    reachedThreshold: 0,
    windowStart: "2026-07-01T00:00:00.000Z",
    windowEnd: "2026-07-21T00:00:00.000Z",
  };
}

describe("SpendBudgetsPanel", () => {
  it("always renders both an org and a workspace card, even with zero configured budgets", () => {
    render(
      <SpendBudgetsPanel
        orgSlug="acme"
        workspaceSlug="main"
        initialBudgets={[]}
        canManage={true}
      />,
    );
    expect(screen.getByTestId("mock-card-org")).toBeInTheDocument();
    expect(screen.getByTestId("mock-card-workspace")).toBeInTheDocument();
    expect(screen.getByTestId("mock-card-org-limit")).toHaveTextContent(
      "empty",
    );
    expect(screen.getByTestId("mock-card-workspace-limit")).toHaveTextContent(
      "empty",
    );
  });

  it("routes each initial budget to its matching scope card", () => {
    render(
      <SpendBudgetsPanel
        orgSlug="acme"
        workspaceSlug="main"
        initialBudgets={[budget("org", 1000), budget("workspace", 100)]}
        canManage={true}
      />,
    );
    expect(screen.getByTestId("mock-card-org-limit")).toHaveTextContent("1000");
    expect(screen.getByTestId("mock-card-workspace-limit")).toHaveTextContent(
      "100",
    );
  });

  it("updates only the saved scope's slot in state, leaving the other scope untouched", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    render(
      <SpendBudgetsPanel
        orgSlug="acme"
        workspaceSlug="main"
        initialBudgets={[budget("org", 1000)]}
        canManage={true}
      />,
    );

    expect(screen.getByTestId("mock-card-workspace-limit")).toHaveTextContent(
      "empty",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "save-workspace" }),
    );

    expect(screen.getByTestId("mock-card-workspace-limit")).toHaveTextContent(
      "999",
    );
    // Org scope's original value is unaffected by the workspace-scope save.
    expect(screen.getByTestId("mock-card-org-limit")).toHaveTextContent("1000");
  });

  it("threads canManage to both scope cards", () => {
    const { rerender } = render(
      <SpendBudgetsPanel
        orgSlug="acme"
        workspaceSlug="main"
        initialBudgets={[]}
        canManage={true}
      />,
    );
    expect(screen.getByTestId("mock-card-org-can-manage")).toHaveTextContent(
      "true",
    );
    expect(
      screen.getByTestId("mock-card-workspace-can-manage"),
    ).toHaveTextContent("true");

    rerender(
      <SpendBudgetsPanel
        orgSlug="acme"
        workspaceSlug="main"
        initialBudgets={[]}
        canManage={false}
      />,
    );
    expect(screen.getByTestId("mock-card-org-can-manage")).toHaveTextContent(
      "false",
    );
    expect(
      screen.getByTestId("mock-card-workspace-can-manage"),
    ).toHaveTextContent("false");
  });
});
