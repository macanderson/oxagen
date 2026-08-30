// @vitest-environment jsdom
/**
 * composer-context-controls.test.tsx
 *
 * Unit tests for ComposerContextControls — the single compact footer row that
 * replaces the two former heavy bars:
 *   - Renders repo (bottom-left) + environment selectors with mode-correct
 *     aria-labels
 *   - "pin" mode shows the pin toggle; "code" mode hides it
 *   - Pin toggle disabled with nothing selected, enabled once a repo is chosen,
 *     and clicking it calls onTogglePin
 *   - Renders the PR chip only when a pr + slugs are provided
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
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
      onClick={() => !disabled && onValueChange?.("acme/widgets")}
    >
      {children}
    </div>
  ),
  SelectTrigger: ({
    children,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
  }) => (
    <div data-testid="select-trigger" aria-label={ariaLabel}>
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

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
    "aria-label": ariaLabel,
    "aria-pressed": ariaPressed,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      {...rest}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// Stub the PR chip — its own behaviour is covered in its own test file.
vi.mock("./composer-pr-status-chip", () => ({
  ComposerPrStatusChip: ({ pr }: { pr: { number: number } }) => (
    <div data-testid="pr-chip">PR #{pr.number}</div>
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    GitBranch: () => <span data-testid="icon-git-branch" />,
    Settings: () => <span data-testid="icon-settings" />,
    Pin: () => <span data-testid="icon-pin" />,
  };
});

import { ComposerContextControls } from "./composer-context-controls";

const REPO: RepoOption = {
  key: "acme/widgets",
  connectionId: "con_1",
  owner: "acme",
  name: "widgets",
  defaultBranch: "main",
};
const ENV: EnvironmentOption = {
  id: "env_default",
  name: "Default",
  isDefault: true,
};

function base() {
  return {
    repositories: [REPO],
    environments: [ENV],
    selectedRepoKey: null,
    selectedEnvId: null,
    onSelectRepo: vi.fn(),
    onSelectEnv: vi.fn(),
  };
}

describe("ComposerContextControls", () => {
  it("renders repo + environment selectors with pin-mode aria-labels", () => {
    const { container } = render(
      <ComposerContextControls {...base()} mode="pin" onTogglePin={vi.fn()} />,
    );
    expect(
      container.querySelector('[aria-label="Pinned repository"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Pinned environment"]'),
    ).not.toBeNull();
  });

  it("uses code-mode aria-labels in code mode and hides the pin toggle", () => {
    const { container } = render(
      <ComposerContextControls {...base()} mode="code" />,
    );
    expect(
      container.querySelector('[aria-label="Select repository"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Select environment"]'),
    ).not.toBeNull();
    expect(screen.queryByTestId("pin-to-chat")).toBeNull();
  });

  it("shows the pin toggle in pin mode, disabled until something is selected", () => {
    render(
      <ComposerContextControls {...base()} mode="pin" onTogglePin={vi.fn()} />,
    );
    expect(screen.getByTestId("pin-to-chat")).toBeDisabled();
  });

  it("enables the pin toggle when a repo is selected and calls onTogglePin", async () => {
    const onTogglePin = vi.fn();
    render(
      <ComposerContextControls
        {...base()}
        selectedRepoKey="acme/widgets"
        mode="pin"
        isPinned={false}
        onTogglePin={onTogglePin}
      />,
    );
    const pin = screen.getByTestId("pin-to-chat");
    expect(pin).toBeEnabled();
    await userEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("mirrors isPinned via aria-pressed", () => {
    render(
      <ComposerContextControls
        {...base()}
        selectedRepoKey="acme/widgets"
        mode="pin"
        isPinned
        onTogglePin={vi.fn()}
      />,
    );
    expect(screen.getByTestId("pin-to-chat")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders the PR chip only when a pr + slugs are provided", () => {
    const { rerender } = render(
      <ComposerContextControls {...base()} mode="code" />,
    );
    expect(screen.queryByTestId("pr-chip")).toBeNull();

    rerender(
      <ComposerContextControls
        {...base()}
        mode="code"
        pr={{
          owner: "acme",
          name: "widgets",
          number: 42,
          url: "u",
          headRef: "b",
        }}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(screen.getByTestId("pr-chip")).toHaveTextContent("PR #42");
  });

  it("selecting a repo calls onSelectRepo with the matching option", async () => {
    const onSelectRepo = vi.fn();
    render(
      <ComposerContextControls
        {...base()}
        onSelectRepo={onSelectRepo}
        mode="code"
      />,
    );
    await userEvent.click(screen.getAllByTestId("select")[0]!);
    expect(onSelectRepo).toHaveBeenCalledWith(REPO);
  });

  it("locked: disables both selectors, wraps them with the lock hint, and hides the pin", () => {
    render(<ComposerContextControls {...base()} mode="code" locked />);
    const controls = screen.getByTestId("composer-context-controls");
    expect(controls).toHaveAttribute("data-locked", "true");

    // Both selectors (repo + env) are wrapped with the lock-hint affordance.
    const wrappers = screen.getAllByTestId("locked-context-control");
    expect(wrappers).toHaveLength(2);
    for (const w of wrappers) {
      expect(w.getAttribute("title")).toContain("Locked for this conversation");
    }

    // The underlying Selects are disabled (isLoading → disabled).
    for (const s of screen.getAllByTestId("select")) {
      expect(s).toHaveAttribute("data-disabled", "true");
    }
  });

  it("locked in pin mode still hides the pin toggle", () => {
    render(
      <ComposerContextControls
        {...base()}
        selectedRepoKey="acme/widgets"
        mode="pin"
        isPinned={false}
        onTogglePin={vi.fn()}
        locked
      />,
    );
    expect(screen.queryByTestId("pin-to-chat")).toBeNull();
  });

  it("locked: a locked selector does not fire onSelect on click", async () => {
    const onSelectRepo = vi.fn();
    render(
      <ComposerContextControls
        {...base()}
        onSelectRepo={onSelectRepo}
        mode="code"
        locked
      />,
    );
    // The mock Select ignores clicks while disabled — no selection escapes.
    await userEvent.click(screen.getAllByTestId("select")[0]!);
    expect(onSelectRepo).not.toHaveBeenCalled();
  });
});
