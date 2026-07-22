// @vitest-environment jsdom
/**
 * scope-budget-card.test.tsx — component tests for ScopeBudgetCard.
 *
 * `@/components/ui/select` and `@/components/ui/switch` are mocked — Base
 * UI's Select popup needs pointer-events/floating-ui layout jsdom can't
 * provide (same constraint documented in packages/ui/src/components/
 * select.test.tsx); this mirrors the established apps/app convention (see
 * e.g. coding-agent-preferences-form.test.tsx, prompt-settings-form.test.tsx).
 *
 * Covers:
 *   (a) Empty scope renders "No ceiling configured" with a "Set a ceiling"
 *       control, never a blank or an error.
 *   (b) Opening the form defaults to monthly (no window-days input shown).
 *   (c) Happy-path monthly save calls setSpendBudgetAction with the mapped
 *       input and notifies onSaved; the form closes back to the status view.
 *   (d) Client-side validation blocks submit (and never calls the action)
 *       for a missing/zero limit.
 *   (e) Switching to rolling reveals the window-days input; submit is
 *       blocked client-side until a positive integer is entered, matching
 *       the contract's refine.
 *   (f) A configured ceiling in the "exceeded" state renders an unmistakable
 *       alert banner in addition to the status badge.
 *   (g) A server-side failure surfaces inline without throwing, and does not
 *       call onSaved.
 *   (h) A configured, DISABLED ceiling renders a distinct "Disabled — not
 *       enforced" badge + alert — never the empty state, never the
 *       exceeded/denied framing even when its ratio reads >= 100% — and the
 *       edit form still lets the user flip it back on.
 *   (i) canManage=false hides the "Set a ceiling" / "Edit ceiling" controls
 *       (empty and configured cases) and shows a read-only explanation
 *       instead, for both a fresh scope and a disabled one.
 */

import * as React from "react";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { SpendBudgetStatus } from "./spend-budget-format";

const { mockSetSpendBudgetAction } = vi.hoisted(() => ({
  mockSetSpendBudgetAction: vi.fn(),
}));

vi.mock("./actions", () => ({
  setSpendBudgetAction: mockSetSpendBudgetAction,
}));

const SelectContext = React.createContext<{
  onValueChange?: (v: string) => void;
}>({});

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <SelectContext.Provider value={{ onValueChange }}>
      <div data-current-value={value}>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const { onValueChange } = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    id,
    checked,
    onCheckedChange,
    disabled,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
  }) => (
    <input
      id={id}
      type="checkbox"
      role="switch"
      checked={checked ?? false}
      aria-checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
      disabled={disabled}
    />
  ),
}));

import { ScopeBudgetCard } from "./scope-budget-card";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function baseProps(
  overrides: Partial<React.ComponentProps<typeof ScopeBudgetCard>> = {},
) {
  return {
    scope: "workspace" as const,
    orgSlug: "acme",
    workspaceSlug: "main",
    budget: null,
    canManage: true,
    onSaved: vi.fn(),
    ...overrides,
  };
}

function workspaceBudget(
  overrides: Partial<SpendBudgetStatus> = {},
): SpendBudgetStatus {
  return {
    scope: "workspace",
    publicId: "bdg_ws1",
    enabled: true,
    period: "monthly",
    windowDays: null,
    limitUsd: 100,
    spentUsd: 25,
    projectedUsd: 50,
    ratio: 0.25,
    state: "ok",
    reachedThreshold: 0,
    windowStart: "2026-07-01T00:00:00.000Z",
    windowEnd: "2026-07-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("ScopeBudgetCard — empty scope", () => {
  it("renders 'No ceiling configured' with a 'Set a ceiling' control, not a blank or an error", () => {
    render(<ScopeBudgetCard {...baseProps()} />);
    expect(
      screen.getByTestId("spend-budget-workspace-empty"),
    ).toBeInTheDocument();
    expect(screen.getByText("No ceiling configured")).toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-set-button"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("spend-budget-workspace-form"),
    ).not.toBeInTheDocument();
  });

  it("opens the form defaulting to monthly, with no window-days input shown", async () => {
    render(<ScopeBudgetCard {...baseProps()} />);
    await userEvent.click(
      screen.getByTestId("spend-budget-workspace-set-button"),
    );

    expect(
      screen.getByTestId("spend-budget-workspace-form"),
    ).toBeInTheDocument();
    const periodDiv = screen
      .getByTestId("spend-budget-workspace-form")
      .querySelector("[data-current-value]");
    expect(periodDiv).toHaveAttribute("data-current-value", "monthly");
    expect(
      screen.queryByTestId("spend-budget-workspace-window-days-input"),
    ).not.toBeInTheDocument();
  });
});

describe("ScopeBudgetCard — monthly save happy path", () => {
  it("calls setSpendBudgetAction with the mapped input and notifies onSaved", async () => {
    const onSaved = vi.fn();
    const saved = workspaceBudget({ limitUsd: 250, spentUsd: 0, ratio: 0 });
    mockSetSpendBudgetAction.mockResolvedValue({ ok: true, budget: saved });

    render(<ScopeBudgetCard {...baseProps({ onSaved })} />);
    await userEvent.click(
      screen.getByTestId("spend-budget-workspace-set-button"),
    );
    await userEvent.type(
      screen.getByTestId("spend-budget-workspace-limit-input"),
      "250",
    );
    await userEvent.click(screen.getByTestId("spend-budget-workspace-save"));

    await waitFor(() =>
      expect(mockSetSpendBudgetAction).toHaveBeenCalledTimes(1),
    );
    expect(mockSetSpendBudgetAction).toHaveBeenCalledWith("acme", "main", {
      scope: "workspace",
      enabled: true,
      period: "monthly",
      windowDays: null,
      limitUsd: 250,
    });
    expect(onSaved).toHaveBeenCalledWith("workspace", saved);

    // The card closes its own edit form on success. Rendering the newly-saved
    // status view is the PARENT's responsibility (it owns `budget` and passes
    // the fresh value back down as a prop) — covered by
    // spend-budgets-panel.test.tsx, which asserts the full round-trip.
    await waitFor(() =>
      expect(
        screen.queryByTestId("spend-budget-workspace-form"),
      ).not.toBeInTheDocument(),
    );
  });
});

describe("ScopeBudgetCard — client-side validation", () => {
  it("blocks submit and never calls the action when the limit is left blank", async () => {
    render(<ScopeBudgetCard {...baseProps()} />);
    await userEvent.click(
      screen.getByTestId("spend-budget-workspace-set-button"),
    );
    await userEvent.click(screen.getByTestId("spend-budget-workspace-save"));

    expect(
      await screen.findByTestId("spend-budget-workspace-form-error"),
    ).toHaveTextContent(/greater than \$0/);
    expect(mockSetSpendBudgetAction).not.toHaveBeenCalled();
  });

  it("blocks submit for a zero limit", async () => {
    render(<ScopeBudgetCard {...baseProps()} />);
    await userEvent.click(
      screen.getByTestId("spend-budget-workspace-set-button"),
    );
    await userEvent.type(
      screen.getByTestId("spend-budget-workspace-limit-input"),
      "0",
    );
    await userEvent.click(screen.getByTestId("spend-budget-workspace-save"));

    expect(
      await screen.findByTestId("spend-budget-workspace-form-error"),
    ).toBeInTheDocument();
    expect(mockSetSpendBudgetAction).not.toHaveBeenCalled();
  });
});

describe("ScopeBudgetCard — rolling period", () => {
  it("reveals the window-days input on switching to rolling, and blocks submit until it is set", async () => {
    render(<ScopeBudgetCard {...baseProps()} />);
    await userEvent.click(
      screen.getByTestId("spend-budget-workspace-set-button"),
    );
    await userEvent.type(
      screen.getByTestId("spend-budget-workspace-limit-input"),
      "100",
    );

    const form = screen.getByTestId("spend-budget-workspace-form");
    await userEvent.click(
      within(form).getByRole("button", { name: /Rolling/ }),
    );
    expect(
      screen.getByTestId("spend-budget-workspace-window-days-input"),
    ).toBeInTheDocument();

    // No window days entered yet — client-side validation blocks the call.
    await userEvent.click(screen.getByTestId("spend-budget-workspace-save"));
    expect(
      await screen.findByTestId("spend-budget-workspace-form-error"),
    ).toHaveTextContent(/Rolling window/);
    expect(mockSetSpendBudgetAction).not.toHaveBeenCalled();

    mockSetSpendBudgetAction.mockResolvedValue({
      ok: true,
      budget: workspaceBudget({
        period: "rolling",
        windowDays: 14,
        limitUsd: 100,
      }),
    });
    await userEvent.type(
      screen.getByTestId("spend-budget-workspace-window-days-input"),
      "14",
    );
    await userEvent.click(screen.getByTestId("spend-budget-workspace-save"));

    await waitFor(() =>
      expect(mockSetSpendBudgetAction).toHaveBeenCalledTimes(1),
    );
    expect(mockSetSpendBudgetAction).toHaveBeenCalledWith("acme", "main", {
      scope: "workspace",
      enabled: true,
      period: "rolling",
      windowDays: 14,
      limitUsd: 100,
    });
  });
});

describe("ScopeBudgetCard — configured ceiling, exceeded state", () => {
  it("renders the status view plus an unmistakable exceeded alert banner", () => {
    const exceeded = workspaceBudget({
      limitUsd: 100,
      spentUsd: 140,
      ratio: 1.4,
      state: "exceeded",
      reachedThreshold: 100,
    });
    render(<ScopeBudgetCard {...baseProps({ budget: exceeded })} />);

    expect(
      screen.queryByTestId("spend-budget-workspace-empty"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-state"),
    ).toHaveTextContent("Exceeded — runs denied");
    expect(
      screen.getByTestId("spend-budget-workspace-exceeded-alert"),
    ).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-edit-button"),
    ).toBeInTheDocument();
  });

  it("does not render the exceeded alert for an on-track ceiling", () => {
    render(
      <ScopeBudgetCard
        {...baseProps({ budget: workspaceBudget({ state: "ok" }) })}
      />,
    );
    expect(
      screen.queryByTestId("spend-budget-workspace-exceeded-alert"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-state"),
    ).toHaveTextContent("On track");
  });
});

describe("ScopeBudgetCard — server error", () => {
  it("surfaces the server error inline without throwing, and does not call onSaved", async () => {
    const onSaved = vi.fn();
    mockSetSpendBudgetAction.mockResolvedValue({
      ok: false,
      error:
        "You don't have permission to manage spend budgets for this workspace.",
    });

    render(<ScopeBudgetCard {...baseProps({ onSaved })} />);
    await userEvent.click(
      screen.getByTestId("spend-budget-workspace-set-button"),
    );
    await userEvent.type(
      screen.getByTestId("spend-budget-workspace-limit-input"),
      "50",
    );
    await userEvent.click(screen.getByTestId("spend-budget-workspace-save"));

    expect(
      await screen.findByTestId("spend-budget-workspace-form-error"),
    ).toHaveTextContent(
      "You don't have permission to manage spend budgets for this workspace.",
    );
    expect(onSaved).not.toHaveBeenCalled();
    // Form stays open so the user can retry rather than losing their input.
    expect(
      screen.getByTestId("spend-budget-workspace-form"),
    ).toBeInTheDocument();
  });
});

describe("ScopeBudgetCard — disabled ceiling", () => {
  it("renders a distinct 'Disabled — not enforced' badge and alert, not the empty state", () => {
    const disabled = workspaceBudget({
      enabled: false,
      state: "ok",
      ratio: 0.25,
    });
    render(<ScopeBudgetCard {...baseProps({ budget: disabled })} />);

    expect(
      screen.queryByTestId("spend-budget-workspace-empty"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-state"),
    ).toHaveTextContent("Disabled — not enforced");
    expect(
      screen.getByTestId("spend-budget-workspace-disabled-alert"),
    ).toBeInTheDocument();
    // The configured numbers still render — a disabled ceiling is informational.
    expect(screen.getByText("$100.00")).toBeInTheDocument();
  });

  it("never shows the exceeded/denied framing for a disabled ceiling, even when ratio >= 100%", () => {
    const disabledButOverLimit = workspaceBudget({
      enabled: false,
      state: "exceeded",
      ratio: 1.4,
      spentUsd: 140,
    });
    render(
      <ScopeBudgetCard {...baseProps({ budget: disabledButOverLimit })} />,
    );

    expect(
      screen.queryByTestId("spend-budget-workspace-exceeded-alert"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-disabled-alert"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-state"),
    ).not.toHaveTextContent("Exceeded");
  });

  it("the edit form pre-fills enabled=false but lets the user flip it back on and save", async () => {
    const disabled = workspaceBudget({ enabled: false });
    const reEnabled = workspaceBudget({ enabled: true });
    mockSetSpendBudgetAction.mockResolvedValue({ ok: true, budget: reEnabled });

    render(<ScopeBudgetCard {...baseProps({ budget: disabled })} />);
    await userEvent.click(
      screen.getByTestId("spend-budget-workspace-edit-button"),
    );

    const enforceSwitch = screen.getByRole("switch");
    expect(enforceSwitch).not.toBeChecked();

    await userEvent.click(enforceSwitch);
    expect(enforceSwitch).toBeChecked();

    await userEvent.click(screen.getByTestId("spend-budget-workspace-save"));

    await waitFor(() =>
      expect(mockSetSpendBudgetAction).toHaveBeenCalledTimes(1),
    );
    expect(mockSetSpendBudgetAction).toHaveBeenCalledWith(
      "acme",
      "main",
      expect.objectContaining({ enabled: true }),
    );
  });
});

describe("ScopeBudgetCard — canManage=false (read-only)", () => {
  it("hides the 'Set a ceiling' control on an empty scope and explains why", () => {
    render(<ScopeBudgetCard {...baseProps({ canManage: false })} />);

    expect(
      screen.getByTestId("spend-budget-workspace-empty"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("spend-budget-workspace-set-button"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-readonly-note"),
    ).toHaveTextContent(
      "Only owners, admins, and billing managers can change spend ceilings.",
    );
  });

  it("hides the 'Edit ceiling' control on a configured scope and explains why", () => {
    render(
      <ScopeBudgetCard
        {...baseProps({ canManage: false, budget: workspaceBudget() })}
      />,
    );

    expect(
      screen.queryByTestId("spend-budget-workspace-edit-button"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-readonly-note"),
    ).toBeInTheDocument();
  });

  it("hides the edit control for a disabled ceiling too", () => {
    render(
      <ScopeBudgetCard
        {...baseProps({
          canManage: false,
          budget: workspaceBudget({ enabled: false }),
        })}
      />,
    );

    expect(
      screen.queryByTestId("spend-budget-workspace-edit-button"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-disabled-alert"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("spend-budget-workspace-readonly-note"),
    ).toBeInTheDocument();
  });
});
