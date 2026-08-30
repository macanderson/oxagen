// @vitest-environment jsdom
/**
 * model-settings-inline.test.tsx
 *
 * Render + interaction tests for ModelSettingsInline:
 *   - Renders model tier selector
 *   - Uses currentTier to pre-select tier
 *   - Shows error when updateModelSettingsAction fails
 *   - Shows success state when action succeeds
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

vi.mock("@/app/actions/update-model-settings.action", () => ({
  updateModelSettingsAction: vi.fn(),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    "aria-busy": ariaBusy,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: string;
    "aria-busy"?: boolean;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-busy={ariaBusy}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    htmlFor,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
  }) => <label htmlFor={htmlFor}>{children}</label>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectTrigger: ({
    children,
    id,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    id?: string;
    "aria-label"?: string;
  }) => (
    <button id={id} aria-label={ariaLabel} type="button">
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <option value={value}>{children}</option>,
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Cpu: vi.fn(() => <span />),
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("ModelSettingsInline", () => {
  it("renders form with aria-label 'Model settings'", async () => {
    const { updateModelSettingsAction } = await import(
      "@/app/actions/update-model-settings.action"
    );
    vi.mocked(updateModelSettingsAction).mockResolvedValue({ ok: true });

    const { default: ModelSettingsInline } = await import(
      "./model-settings-inline"
    );
    render(<ModelSettingsInline />);
    expect(
      screen.getByRole("form", { name: "Model settings" }),
    ).toBeInTheDocument();
  });

  it("renders the default tier label", async () => {
    const { updateModelSettingsAction } = await import(
      "@/app/actions/update-model-settings.action"
    );
    vi.mocked(updateModelSettingsAction).mockResolvedValue({ ok: true });

    const { default: ModelSettingsInline } = await import(
      "./model-settings-inline"
    );
    render(<ModelSettingsInline />);
    expect(screen.getByText("Default model tier")).toBeInTheDocument();
  });

  it("renders Save settings button", async () => {
    const { updateModelSettingsAction } = await import(
      "@/app/actions/update-model-settings.action"
    );
    vi.mocked(updateModelSettingsAction).mockResolvedValue({ ok: true });

    const { default: ModelSettingsInline } = await import(
      "./model-settings-inline"
    );
    render(<ModelSettingsInline />);
    expect(
      screen.getByRole("button", { name: "Save settings" }),
    ).toBeInTheDocument();
  });

  it("shows error when updateModelSettingsAction fails", async () => {
    const { updateModelSettingsAction } = await import(
      "@/app/actions/update-model-settings.action"
    );
    vi.mocked(updateModelSettingsAction).mockResolvedValue({
      ok: false,
      error: "Permission denied",
    });

    const { default: ModelSettingsInline } = await import(
      "./model-settings-inline"
    );
    render(<ModelSettingsInline orgSlug="my-org" workspaceSlug="default" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Save settings" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Permission denied");
    });
  });

  it("shows success state when action succeeds", async () => {
    const { updateModelSettingsAction } = await import(
      "@/app/actions/update-model-settings.action"
    );
    vi.mocked(updateModelSettingsAction).mockResolvedValue({ ok: true });

    const { default: ModelSettingsInline } = await import(
      "./model-settings-inline"
    );
    render(<ModelSettingsInline orgSlug="my-org" workspaceSlug="default" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Save settings" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Model settings updated")).toBeInTheDocument();
    });
  });

  it("shows the current tier in the success state", async () => {
    const { updateModelSettingsAction } = await import(
      "@/app/actions/update-model-settings.action"
    );
    vi.mocked(updateModelSettingsAction).mockResolvedValue({ ok: true });

    const { default: ModelSettingsInline } = await import(
      "./model-settings-inline"
    );
    render(
      <ModelSettingsInline
        orgSlug="my-org"
        workspaceSlug="default"
        currentTier="fast"
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save settings" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/Default tier: fast/)).toBeInTheDocument();
    });
  });
});
