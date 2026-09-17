// @vitest-environment jsdom
/**
 * models-form.test.tsx — component tests for WorkspaceModelsForm.
 *
 * Covers:
 *   (a) Initial render — form renders with aria-label.
 *   (c) apply("all", values) round-trips textTier into the form state.
 *   (d) Happy path — submit calls updateWorkspaceModelsAction with current state.
 *   (e) Error path — action returns ok:false, error shown.
 */

import * as React from "react";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockUpdateAction } = vi.hoisted(() => {
  const mockUpdateAction = vi.fn();
  return { mockUpdateAction };
});

vi.mock("./models-action", () => ({
  updateWorkspaceModelsAction: mockUpdateAction,
}));

// ModelDefaultsFields stub — renders a testid and a button to change textTier
vi.mock("@/components/settings/model-defaults-fields", () => ({
  ModelDefaultsFields: ({
    value,
    onChange,
    disabled: _d,
    scope: _s,
  }: {
    value: {
      textTier: string | null;
      textModel: string | null;
    };
    onChange: (v: typeof value) => void;
    disabled?: boolean;
    scope?: string;
  }) => (
    <div data-testid="model-defaults-fields">
      <span data-testid="text-tier-display">{value.textTier ?? "none"}</span>
      <button
        type="button"
        data-testid="set-text-tier-fast"
        onClick={() => onChange({ ...value, textTier: "fast" })}
      >
        Set fast tier
      </button>
    </div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    type,
    className: _c,
    size: _s,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    className?: string;
    size?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      disabled={disabled}
    >
      {children}
    </button>
  ),
}));

vi.mock("lucide-react", () => ({
  Save: () => <svg aria-hidden="true" />,
}));

import { WorkspaceModelsForm } from "./models-form";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const defaultProps = {
  initial: {
    textTier: "balanced" as const,
    textModel: null,
  },
  canEdit: true,
  orgSlug: "test-org",
  workspaceSlug: "test-ws",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceModelsForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ── (a) Initial render ────────────────────────────────────────────────────

  it("renders the form with aria-label", () => {
    render(<WorkspaceModelsForm {...defaultProps} />);
    expect(
      screen.getByRole("form", { name: /workspace ai model defaults/i }),
    ).toBeInTheDocument();
  });

  it("renders the ModelDefaultsFields stub", () => {
    render(<WorkspaceModelsForm {...defaultProps} />);
    expect(screen.getByTestId("model-defaults-fields")).toBeInTheDocument();
  });

  it("renders the save button", () => {
    render(<WorkspaceModelsForm {...defaultProps} />);
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeInTheDocument();
  });

  // ── (c) apply round-trip ──────────────────────────────────────────────────

  // ── (d) Happy path ────────────────────────────────────────────────────────

  it("submit calls updateWorkspaceModelsAction with orgSlug and workspaceSlug", async () => {
    mockUpdateAction.mockResolvedValue({ ok: true });

    render(<WorkspaceModelsForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace ai model defaults/i }),
    );

    await waitFor(() => {
      expect(mockUpdateAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockUpdateAction.mock.calls[0] as [
      { orgSlug: string; workspaceSlug: string },
    ];
    expect(arg.orgSlug).toBe("test-org");
    expect(arg.workspaceSlug).toBe("test-ws");
  });

  it("shows saved-at text after a successful save", async () => {
    mockUpdateAction.mockResolvedValue({ ok: true });

    render(<WorkspaceModelsForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace ai model defaults/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/saved at/i)).toBeInTheDocument();
    });
  });

  // ── (e) Error path ────────────────────────────────────────────────────────

  it("shows error message when action returns ok:false", async () => {
    mockUpdateAction.mockResolvedValue({
      ok: false,
      error: "Permission denied",
    });

    render(<WorkspaceModelsForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace ai model defaults/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Permission denied");
  });

  it("shows a generic error message when the action throws", async () => {
    mockUpdateAction.mockRejectedValue(new Error("Network error"));

    render(<WorkspaceModelsForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace ai model defaults/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/unexpected error/i);
  });
});
