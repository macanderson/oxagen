// @vitest-environment jsdom
/**
 * models-form.test.tsx — component tests for WorkspaceModelsForm.
 *
 * Covers:
 *   (a) Initial render — form renders with aria-label.
 *   (b) useRegisterFillableForm is called (field names verified via mock capture).
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

const { mockUpdateAction, mockUseRegisterFillableForm } = vi.hoisted(() => {
  const mockUpdateAction = vi.fn();
  const mockUseRegisterFillableForm = vi.fn();
  return { mockUpdateAction, mockUseRegisterFillableForm };
});

vi.mock("./models-action", () => ({
  updateWorkspaceModelsAction: mockUpdateAction,
}));

vi.mock("@/lib/page-context", () => ({
  useRegisterFillableForm: mockUseRegisterFillableForm,
}));

// Capture the apply callback so we can test round-trips.
let capturedApply: ((proposed: Record<string, unknown>) => void) | null = null;

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
      imageModel: string | null;
      videoModel: string | null;
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
    imageModel: null,
    videoModel: null,
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
    capturedApply = null;
    // Set the implementation after clearAllMocks so we can capture the apply cb.
    mockUseRegisterFillableForm.mockImplementation(
      (spec: {
        formId: string;
        fields: unknown[];
        apply: (proposed: Record<string, unknown>) => void;
      }) => {
        capturedApply = spec.apply;
      },
    );
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

  // ── (b) useRegisterFillableForm called ────────────────────────────────────

  it("calls useRegisterFillableForm with a formId containing 'workspace-models'", () => {
    render(<WorkspaceModelsForm {...defaultProps} />);
    expect(mockUseRegisterFillableForm).toHaveBeenCalled();
    const callArg = (
      mockUseRegisterFillableForm.mock.calls[0] as unknown as [
        { formId: string; fields: unknown[]; title: string },
      ]
    )[0];
    expect(callArg.formId).toContain("workspace-models");
  });

  it("registers 4 fields", () => {
    render(<WorkspaceModelsForm {...defaultProps} />);
    const callArg = (
      mockUseRegisterFillableForm.mock.calls[0] as unknown as [
        { formId: string; fields: { name: string }[] },
      ]
    )[0];
    expect(callArg.fields).toHaveLength(4);
    const names = callArg.fields.map((f) => f.name);
    expect(names).toContain("textTier");
    expect(names).toContain("textModel");
    expect(names).toContain("imageModel");
    expect(names).toContain("videoModel");
  });

  // ── (c) apply round-trip ──────────────────────────────────────────────────

  it("apply updates textTier to 'fast' and that value is sent on submit", async () => {
    mockUpdateAction.mockResolvedValue({ ok: true });

    render(<WorkspaceModelsForm {...defaultProps} />);

    expect(capturedApply).not.toBeNull();
    // Apply a new textTier via the captured callback
    act(() => {
      capturedApply!({ textTier: "fast" });
    });

    // Submit the form
    fireEvent.submit(
      screen.getByRole("form", { name: /workspace ai model defaults/i }),
    );

    await waitFor(() => {
      expect(mockUpdateAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockUpdateAction.mock.calls[0] as [
      {
        orgSlug: string;
        workspaceSlug: string;
        defaultTextTier: string;
        defaultTextModel: string | null;
        defaultImageModel: string | null;
        defaultVideoModel: string | null;
      },
    ];
    expect(arg.defaultTextTier).toBe("fast");
  });

  it("apply ignores invalid textTier values", async () => {
    mockUpdateAction.mockResolvedValue({ ok: true });

    render(<WorkspaceModelsForm {...defaultProps} />);

    expect(capturedApply).not.toBeNull();
    // Pass invalid tier — should keep "balanced"
    act(() => {
      capturedApply!({ textTier: "ultra" });
    });

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace ai model defaults/i }),
    );

    await waitFor(() => {
      expect(mockUpdateAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockUpdateAction.mock.calls[0] as [
      { defaultTextTier: string },
    ];
    expect(arg.defaultTextTier).toBe("balanced");
  });

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
