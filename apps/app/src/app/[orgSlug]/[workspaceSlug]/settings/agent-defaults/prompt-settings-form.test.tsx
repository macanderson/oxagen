// @vitest-environment jsdom
/**
 * prompt-settings-form.test.tsx — component tests for PromptSettingsForm.
 *
 * Covers:
 *   (a) Initial render — form renders with aria-label.
 *   (b) useRegisterFillableForm is called (formId verified via mock capture).
 *   (c) apply round-trip: autoImprove + additionalInstructions reflected on submit.
 *   (d) Happy path — submit calls updatePromptSettingsAction.
 *   (e) Error toast on action failure.
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
import type { PromptSettingsInput } from "./prompt-settings-action";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockUpdatePromptSettingsAction,
  mockAddToast,
  mockUseRegisterFillableForm,
} = vi.hoisted(() => ({
  mockUpdatePromptSettingsAction: vi.fn(),
  mockAddToast: vi.fn(),
  mockUseRegisterFillableForm: vi.fn(),
}));

vi.mock("./prompt-settings-action", () => ({
  updatePromptSettingsAction: mockUpdatePromptSettingsAction,
}));

vi.mock("@/lib/page-context", () => ({
  useRegisterFillableForm: mockUseRegisterFillableForm,
}));

// Capture the apply callback so we can test round-trips.
let capturedApply: ((proposed: Record<string, unknown>) => void) | null = null;

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

// Switch — simple checkbox that forwards checked/onCheckedChange
vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    id,
    checked,
    onCheckedChange,
    disabled,
    "aria-labelledby": _al,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    disabled?: boolean;
    "aria-labelledby"?: string;
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

// MarkdownCodeEditor wraps CodeMirror, which renders a contenteditable
// `.cm-content` div (role="textbox") rather than a native <textarea>. For
// component tests we stand in a plain <textarea> so existing
// getByRole("textbox") / value assertions keep working without dragging in
// CodeMirror's DOM/measurement APIs (unavailable in jsdom).
vi.mock("@/components/ui/markdown-code-editor", () => ({
  MarkdownCodeEditor: ({
    id,
    value,
    onChange,
    disabled,
    placeholder,
    maxLength,
    ariaLabel,
    className: _c,
    minHeight: _mh,
    maxHeight: _mxh,
  }: {
    id?: string;
    value?: string;
    onChange?: (value: string) => void;
    disabled?: boolean;
    placeholder?: string;
    maxLength?: number;
    ariaLabel?: string;
    className?: string;
    minHeight?: string;
    maxHeight?: string;
  }) => (
    <textarea
      id={id}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      disabled={disabled}
      placeholder={placeholder}
      maxLength={maxLength}
      aria-label={ariaLabel}
    />
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant: _v,
    size: _s,
  }: {
    children: React.ReactNode;
    variant?: string;
    size?: string;
  }) => <span data-testid="badge">{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    type,
    size: _s,
    className: _c,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    size?: string;
    className?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      disabled={disabled}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    id,
    htmlFor,
    className: _c,
  }: {
    children: React.ReactNode;
    id?: string;
    htmlFor?: string;
    className?: string;
  }) => (
    <label id={id} htmlFor={htmlFor}>
      {children}
    </label>
  ),
}));

vi.mock("lucide-react", () => ({
  Save: () => <svg aria-hidden="true" />,
  Lock: () => <svg aria-hidden="true" />,
  ChevronDown: () => <svg aria-hidden="true" />,
  ChevronUp: () => <svg aria-hidden="true" />,
}));

import { PromptSettingsForm } from "./prompt-settings-form";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const defaultProps = {
  initial: {
    autoImprovePrompts: false,
    additionalInstructions: null,
    overrides: {},
  },
  canEdit: true,
  isEnterprise: false,
  orgSlug: "test-org",
  workspaceSlug: "test-ws",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PromptSettingsForm", () => {
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
    render(<PromptSettingsForm {...defaultProps} />);
    expect(
      screen.getByRole("form", { name: /workspace prompt settings/i }),
    ).toBeInTheDocument();
  });

  it("renders the Save button", () => {
    render(<PromptSettingsForm {...defaultProps} />);
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeInTheDocument();
  });

  it("renders the auto-improve switch", () => {
    render(<PromptSettingsForm {...defaultProps} />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("renders the additional instructions textarea", () => {
    render(<PromptSettingsForm {...defaultProps} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  // ── (b) useRegisterFillableForm called ────────────────────────────────────

  it("calls useRegisterFillableForm with a formId containing 'workspace-prompts'", () => {
    render(<PromptSettingsForm {...defaultProps} />);
    expect(mockUseRegisterFillableForm).toHaveBeenCalled();
    const callArg = (
      mockUseRegisterFillableForm.mock.calls[0] as unknown as [
        { formId: string; fields: unknown[] },
      ]
    )[0];
    expect(callArg.formId).toContain("workspace-prompts");
  });

  it("registers 2 fields: autoImprove and additionalInstructions", () => {
    render(<PromptSettingsForm {...defaultProps} />);
    const callArg = (
      mockUseRegisterFillableForm.mock.calls[0] as unknown as [
        { formId: string; fields: { name: string }[] },
      ]
    )[0];
    expect(callArg.fields).toHaveLength(2);
    const names = callArg.fields.map((f) => f.name);
    expect(names).toContain("autoImprove");
    expect(names).toContain("additionalInstructions");
  });

  // ── (c) apply round-trip ──────────────────────────────────────────────────

  it("apply round-trips autoImprove and additionalInstructions into the action call", async () => {
    mockUpdatePromptSettingsAction.mockResolvedValue({ ok: true, data: {} });

    render(<PromptSettingsForm {...defaultProps} />);

    expect(capturedApply).not.toBeNull();
    act(() => {
      capturedApply!({
        autoImprove: true,
        additionalInstructions: "Be concise.",
      });
    });

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace prompt settings/i }),
    );

    await waitFor(() => {
      expect(mockUpdatePromptSettingsAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockUpdatePromptSettingsAction.mock.calls[0] as [
      PromptSettingsInput,
    ];
    expect(arg.autoImprovePrompts).toBe(true);
    expect(arg.additionalInstructions).toBe("Be concise.");
  });

  it("apply ignores non-boolean autoImprove values", async () => {
    mockUpdatePromptSettingsAction.mockResolvedValue({ ok: true, data: {} });

    render(<PromptSettingsForm {...defaultProps} />);

    expect(capturedApply).not.toBeNull();
    // Pass invalid type for autoImprove — should remain false
    capturedApply!({ autoImprove: "yes" });

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace prompt settings/i }),
    );

    await waitFor(() => {
      expect(mockUpdatePromptSettingsAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockUpdatePromptSettingsAction.mock.calls[0] as [
      PromptSettingsInput,
    ];
    expect(arg.autoImprovePrompts).toBe(false);
  });

  // ── (d) Happy path ────────────────────────────────────────────────────────

  it("submit calls updatePromptSettingsAction with orgSlug and workspaceSlug", async () => {
    mockUpdatePromptSettingsAction.mockResolvedValue({ ok: true, data: {} });

    render(<PromptSettingsForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace prompt settings/i }),
    );

    await waitFor(() => {
      expect(mockUpdatePromptSettingsAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockUpdatePromptSettingsAction.mock.calls[0] as [
      PromptSettingsInput,
    ];
    expect(arg.orgSlug).toBe("test-org");
    expect(arg.workspaceSlug).toBe("test-ws");
  });

  it("shows a success toast on ok:true response", async () => {
    mockUpdatePromptSettingsAction.mockResolvedValue({ ok: true, data: {} });

    render(<PromptSettingsForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace prompt settings/i }),
    );

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledOnce();
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Prompt settings saved" }),
    );
  });

  // ── (e) Error toast on failure ────────────────────────────────────────────

  it("shows an error toast when action returns ok:false", async () => {
    mockUpdatePromptSettingsAction.mockResolvedValue({
      ok: false,
      error: "Not authorized",
    });

    render(<PromptSettingsForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace prompt settings/i }),
    );

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledOnce();
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to save" }),
    );
  });

  it("shows enterprise upsell toast when tierDenied is true", async () => {
    mockUpdatePromptSettingsAction.mockResolvedValue({
      ok: false,
      error: "Tier denied",
      tierDenied: true,
    });

    render(<PromptSettingsForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace prompt settings/i }),
    );

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledOnce();
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Enterprise feature" }),
    );
  });

  it("shows an error toast when the action throws", async () => {
    mockUpdatePromptSettingsAction.mockRejectedValue(
      new Error("Network error"),
    );

    render(<PromptSettingsForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace prompt settings/i }),
    );

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledOnce();
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to save" }),
    );
  });
});

// ── Enterprise gating ───────────────────────────────────────────────────────

describe("PromptSettingsForm — per-prompt override entitlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRegisterFillableForm.mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
  });

  /**
   * Opens the collapsible "Per-prompt overrides" panel by clicking its toggle.
   */
  function openOverridesPanel() {
    fireEvent.click(
      screen.getByRole("button", { name: /per-prompt overrides/i }),
    );
  }

  it("shows 'Requires Enterprise plan' overlay and disabled textareas when isEnterprise is false", () => {
    render(<PromptSettingsForm {...defaultProps} isEnterprise={false} />);
    openOverridesPanel();

    // All three override textareas should be disabled.
    const overrideTextareas = screen
      .getAllByRole("textbox")
      .filter((el) => el.id?.startsWith("override-"));
    expect(overrideTextareas.length).toBeGreaterThan(0);
    for (const textarea of overrideTextareas) {
      expect(textarea).toBeDisabled();
    }

    // Overlay text present.
    expect(
      screen.getAllByText(/requires enterprise plan/i).length,
    ).toBeGreaterThan(0);
  });

  it("does not show 'Requires Enterprise plan' overlay and enables textareas when isEnterprise is true", () => {
    render(<PromptSettingsForm {...defaultProps} isEnterprise canEdit />);
    openOverridesPanel();

    // None of the override textareas should be disabled.
    const overrideTextareas = screen
      .getAllByRole("textbox")
      .filter((el) => el.id?.startsWith("override-"));
    expect(overrideTextareas.length).toBeGreaterThan(0);
    for (const textarea of overrideTextareas) {
      expect(textarea).not.toBeDisabled();
    }

    // Overlay text should NOT be present.
    expect(screen.queryByText(/requires enterprise plan/i)).toBeNull();
  });

  it("disables override textareas even for Enterprise when canEdit is false", () => {
    render(
      <PromptSettingsForm {...defaultProps} isEnterprise canEdit={false} />,
    );
    openOverridesPanel();

    const overrideTextareas = screen
      .getAllByRole("textbox")
      .filter((el) => el.id?.startsWith("override-"));
    expect(overrideTextareas.length).toBeGreaterThan(0);
    for (const textarea of overrideTextareas) {
      expect(textarea).toBeDisabled();
    }
  });

  it("hides the lock icon and Enterprise badge in the section header when isEnterprise is true", () => {
    render(<PromptSettingsForm {...defaultProps} isEnterprise />);

    // The section toggle button should not contain the word "Enterprise" as a badge.
    const toggleButton = screen.getByRole("button", {
      name: /per-prompt overrides/i,
    });
    // The Enterprise badge (rendered as a <span data-testid="badge">) should not be present
    // inside the toggle button when the org is on Enterprise.
    const badgesInToggle = Array.from(
      toggleButton.querySelectorAll("[data-testid='badge']"),
    );
    const enterpriseBadgeText = badgesInToggle.find((b) =>
      b.textContent?.toLowerCase().includes("enterprise"),
    );
    expect(enterpriseBadgeText).toBeUndefined();
  });
});
