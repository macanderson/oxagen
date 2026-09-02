// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * preferences-form.test.tsx — component tests for PreferencesForm.
 *
 * Covers:
 *   (a) Initial render — sections visible (Appearance, Interactive agent, Save button).
 *   (b) Happy path — submit calls updatePreferencesAction with form state, toast shown.
 *   (c) Error path — action returns ok:false, error toast shown.
 *   (d) Submitting state — button disabled while saving.
 *
 * Mock seam: ./preferences-action (updatePreferencesAction),
 *            @/lib/page-context, @/components/ui/toast, various UI primitives.
 */

import * as React from "react";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PreferencesInput } from "./preferences-action";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockUpdatePreferencesAction, mockAddToast } = vi.hoisted(() => ({
  mockUpdatePreferencesAction: vi.fn(),
  mockAddToast: vi.fn(),
}));

vi.mock("./preferences-action", () => ({
  updatePreferencesAction: mockUpdatePreferencesAction,
}));

// page-context hooks — no-op in tests
vi.mock("@/lib/page-context", () => ({
  useRegisterFillableForm: vi.fn(),
  useRegisterPageEntity: vi.fn(),
}));

// Toast — capture the add fn
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

// ModelDefaultsFields — simplified stub that renders hidden inputs and exposes
// a value-change trigger via a data attribute
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
    <div data-testid="model-defaults">
      <span data-testid="text-tier">{value.textTier ?? "none"}</span>
      <button
        type="button"
        data-testid="set-text-tier"
        onClick={() => onChange({ ...value, textTier: "fast" })}
      >
        Set fast tier
      </button>
    </div>
  ),
}));

vi.mock("@/components/ui/segmented-control", () => ({
  SegmentedControl: ({
    children,
    value,
    onValueChange,
    disabled: _d,
    "aria-labelledby": _l,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (v: string) => void;
    disabled?: boolean;
    "aria-labelledby"?: string;
  }) => (
    <div role="group" data-value={value}>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        const { value: itemValue, children: itemChildren } = child.props as {
          value: string;
          children: React.ReactNode;
        };
        return (
          <button
            type="button"
            role="radio"
            aria-checked={value === itemValue}
            onClick={() => onValueChange(itemValue)}
          >
            {itemChildren}
          </button>
        );
      })}
    </div>
  ),
  SegmentedControlItem: ({
    children,
    value: _v,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <>{children}</>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    type,
    className: _c,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
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
  }: {
    children: React.ReactNode;
    id?: string;
    htmlFor?: string;
  }) => (
    <label id={id} htmlFor={htmlFor}>
      {children}
    </label>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
    disabled: _d,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string | null) => void;
    disabled?: boolean;
  }) => (
    <div data-testid="select-root" data-value={value}>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child;
        return React.cloneElement(
          child as React.ReactElement<{
            onValueChange?: (v: string | null) => void;
          }>,
          { onValueChange },
        );
      })}
    </div>
  ),
  SelectTrigger: ({
    children,
  }: {
    children: React.ReactNode;
    id?: string;
    "aria-labelledby"?: string;
  }) => <div>{children}</div>,
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectPopup: ({
    children,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value: _v,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <div>{children}</div>,
}));

// Locale constants — use a minimal stub to avoid the Intl.supportedValuesOf call in jsdom
vi.mock("./locale-constants", () => ({
  TIMEZONE_OPTIONS: [
    { value: "UTC", label: "UTC (GMT+0)" },
    { value: "America/New_York", label: "America/New York (GMT-5)" },
  ],
  LANGUAGE_OPTIONS: [
    { value: "en", label: "English" },
    { value: "es", label: "Spanish — Español" },
  ],
}));

import { PreferencesForm } from "./preferences-form";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const initialProps: React.ComponentProps<typeof PreferencesForm>["initial"] = {
  fontSize: "medium",
  density: "comfortable",
  enterToSubmit: true,
  pendingPromptBehavior: "queue",
  defaultTextTier: "balanced",
  defaultTextModel: "claude-3-sonnet",
  defaultImageModel: null,
  defaultVideoModel: null,
  timezone: "America/New_York",
  language: "en",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PreferencesForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // (a) Initial render
  // ---------------------------------------------------------------------------

  it("renders the Appearance section heading", () => {
    render(<PreferencesForm initial={initialProps} />);
    expect(screen.getByText(/appearance/i)).toBeInTheDocument();
  });

  it("renders the Save preferences button", () => {
    render(<PreferencesForm initial={initialProps} />);
    expect(
      screen.getByRole("button", { name: /save preferences/i }),
    ).toBeInTheDocument();
  });

  it("renders the form with aria-label", () => {
    render(<PreferencesForm initial={initialProps} />);
    expect(
      screen.getByRole("form", { name: /preferences settings/i }),
    ).toBeInTheDocument();
  });

  it("renders the model defaults section", () => {
    render(<PreferencesForm initial={initialProps} />);
    expect(screen.getByTestId("model-defaults")).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // (b) Happy path — save preferences
  // ---------------------------------------------------------------------------

  it("calls updatePreferencesAction with current state on submit", async () => {
    mockUpdatePreferencesAction.mockResolvedValue({ ok: true });

    render(<PreferencesForm initial={initialProps} />);

    // Submit the form
    fireEvent.submit(
      screen.getByRole("form", { name: /preferences settings/i }),
    );

    await waitFor(() => {
      expect(mockUpdatePreferencesAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockUpdatePreferencesAction.mock.calls[0] as [
      PreferencesInput,
    ];
    expect(arg.fontSize).toBe("medium");
    expect(arg.density).toBe("comfortable");
    expect(arg.enterToSubmit).toBe(true);
    expect(arg.pendingPromptBehavior).toBe("queue");
    expect(arg.defaultTextTier).toBe("balanced");
    expect(arg.defaultTextModel).toBe("claude-3-sonnet");
  });

  it("shows a success toast on ok:true response", async () => {
    mockUpdatePreferencesAction.mockResolvedValue({ ok: true });

    render(<PreferencesForm initial={initialProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /preferences settings/i }),
    );

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledOnce();
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Preferences saved" }),
    );
  });

  it("shows 'Saved' status text after successful save", async () => {
    mockUpdatePreferencesAction.mockResolvedValue({ ok: true });

    render(<PreferencesForm initial={initialProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /preferences settings/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    expect(screen.getByRole("status")).toHaveTextContent(/saved/i);
  });

  it("carries changed model defaults into the action call", async () => {
    const user = userEvent.setup({ delay: null });
    mockUpdatePreferencesAction.mockResolvedValue({ ok: true });

    render(<PreferencesForm initial={initialProps} />);

    // Click the stub button to change the textTier
    await user.click(screen.getByTestId("set-text-tier"));

    fireEvent.submit(
      screen.getByRole("form", { name: /preferences settings/i }),
    );

    await waitFor(() => {
      expect(mockUpdatePreferencesAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockUpdatePreferencesAction.mock.calls[0] as [
      PreferencesInput,
    ];
    expect(arg.defaultTextTier).toBe("fast");
  });

  // ---------------------------------------------------------------------------
  // (c) Error path
  // ---------------------------------------------------------------------------

  it("shows an error toast when action returns ok:false", async () => {
    mockUpdatePreferencesAction.mockResolvedValue({
      ok: false,
      error: "Failed to save preferences",
    });

    render(<PreferencesForm initial={initialProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /preferences settings/i }),
    );

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledOnce();
    });

    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to save preferences" }),
    );
  });

  // ---------------------------------------------------------------------------
  // (d) Submitting state
  // ---------------------------------------------------------------------------

  it("disables the save button while saving", async () => {
    let resolve!: (val: { ok: boolean }) => void;
    mockUpdatePreferencesAction.mockReturnValue(
      new Promise<{ ok: boolean }>((r) => {
        resolve = r;
      }),
    );

    render(<PreferencesForm initial={initialProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /preferences settings/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /saving/i })).toBeDisabled();
    });

    resolve({ ok: true });

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
  });
});
