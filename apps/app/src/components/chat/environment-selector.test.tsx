// @vitest-environment jsdom
/**
 * environment-selector.test.tsx
 *
 * Unit tests for EnvironmentSelector:
 *   - Renders each environment's name
 *   - Shows a "Default" badge only for the isDefault environment
 *   - Selecting an environment calls onSelectEnv with its id
 *   - Disabled when isLoading or there are no environments
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EnvironmentOption } from "./environment-selector";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="badge">{children}</span>
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
    disabled,
  }: {
    children: React.ReactNode;
    onValueChange?: (v: string) => void;
    value?: string;
    disabled?: boolean;
  }) => (
    <div
      data-testid="select"
      data-value={value}
      data-disabled={disabled}
      onClick={() => !disabled && onValueChange?.("env_prod")}
    >
      {children}
    </div>
  ),
  SelectTrigger: ({
    children,
    className,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    className?: string;
    "aria-label"?: string;
  }) => (
    <div
      data-testid="select-trigger"
      className={className}
      aria-label={ariaLabel}
    >
      {children}
    </div>
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
  }) => <div data-value={value}>{children}</div>,
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return { ...real, Settings: () => <span data-testid="icon-settings" /> };
});

function makeEnv(
  overrides: Partial<EnvironmentOption> = {},
): EnvironmentOption {
  return { id: "env_default", name: "Default", isDefault: true, ...overrides };
}

describe("EnvironmentSelector", () => {
  it("renders each environment's name", async () => {
    const { EnvironmentSelector } = await import("./environment-selector");
    render(
      <EnvironmentSelector
        environments={[
          makeEnv(),
          makeEnv({ id: "env_prod", name: "Production", isDefault: false }),
        ]}
        selectedEnvId={null}
        onSelectEnv={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Default").length).toBeGreaterThan(0);
    expect(screen.getByText("Production")).toBeInTheDocument();
  });

  it("shows a Default badge only for the isDefault environment", async () => {
    const { EnvironmentSelector } = await import("./environment-selector");
    render(
      <EnvironmentSelector
        environments={[
          makeEnv(),
          makeEnv({ id: "env_prod", name: "Production", isDefault: false }),
        ]}
        selectedEnvId={null}
        onSelectEnv={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("badge")).toHaveLength(1);
  });

  it("calls onSelectEnv with the selected id", async () => {
    const onSelectEnv = vi.fn();
    const { EnvironmentSelector } = await import("./environment-selector");
    render(
      <EnvironmentSelector
        environments={[makeEnv({ id: "env_prod" })]}
        selectedEnvId={null}
        onSelectEnv={onSelectEnv}
      />,
    );
    await userEvent.click(screen.getByTestId("select"));
    expect(onSelectEnv).toHaveBeenCalledWith("env_prod");
  });

  it("is disabled when isLoading is true", async () => {
    const { EnvironmentSelector } = await import("./environment-selector");
    render(
      <EnvironmentSelector
        environments={[makeEnv()]}
        selectedEnvId={null}
        onSelectEnv={vi.fn()}
        isLoading
      />,
    );
    expect(screen.getByTestId("select")).toHaveAttribute(
      "data-disabled",
      "true",
    );
  });

  it("is disabled when there are no environments", async () => {
    const { EnvironmentSelector } = await import("./environment-selector");
    render(
      <EnvironmentSelector
        environments={[]}
        selectedEnvId={null}
        onSelectEnv={vi.fn()}
      />,
    );
    expect(screen.getByTestId("select")).toHaveAttribute(
      "data-disabled",
      "true",
    );
  });

  it("uses a mobile-first full-width trigger with a fixed desktop width", async () => {
    const { EnvironmentSelector } = await import("./environment-selector");
    render(
      <EnvironmentSelector
        environments={[makeEnv()]}
        selectedEnvId={null}
        onSelectEnv={vi.fn()}
      />,
    );
    const trigger = screen.getByTestId("select-trigger");
    expect(trigger.className).toContain("w-full");
    expect(trigger.className).toContain("sm:w-40");
    expect(trigger.className).toContain("min-h-11");
  });

  it("appends a caller-supplied className to the trigger", async () => {
    const { EnvironmentSelector } = await import("./environment-selector");
    render(
      <EnvironmentSelector
        environments={[makeEnv()]}
        selectedEnvId={null}
        onSelectEnv={vi.fn()}
        className="custom-class"
      />,
    );
    expect(screen.getByTestId("select-trigger").className).toContain(
      "custom-class",
    );
  });
});
