// @vitest-environment jsdom
/**
 * chat-context-bar.test.tsx
 *
 * Unit tests for ChatContextBar — the persistent pin affordance shown above the
 * composer when code mode is off:
 *   - Renders the repo + environment selectors with their "Pinned …" aria-labels
 *   - Pin button disabled when nothing is selected and not pinned; enabled once
 *     a repo is selected
 *   - Clicking the pin button calls onTogglePin
 *   - aria-pressed mirrors isPinned; the pinned summary shows only when pinned
 *     with a selection
 *   - Selecting a repo via the Select calls onSelectRepo with the RepoOption
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

// Minimal Select shim (mirrors repo-selector.test.tsx): clicking fires
// onValueChange with the repo key "acme/widgets" — enough to exercise
// RepoSelector's onSelectRepo lookup without pulling in Base UI/portals.
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
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
}));

// Button shim — renders a real <button> preserving aria/disabled/testid so the
// pin control can be inspected without dragging in Base UI.
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    disabled,
    "aria-label": ariaLabel,
    "aria-pressed": ariaPressed,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
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

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...rest }: { children: React.ReactNode }) => (
    <span {...rest}>{children}</span>
  ),
}));

// Tooltip shim — the coss-ui `render` prop pattern: TooltipTrigger renders the
// element passed as `render` (the pin Button).
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactElement }) => render,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

const REPO: RepoOption = {
  key: "acme/widgets",
  connectionId: "con_1",
  owner: "acme",
  name: "widgets",
  defaultBranch: "main",
};

const ENV: EnvironmentOption = { id: "env_default", name: "Default", isDefault: true };

describe("ChatContextBar", () => {
  it("renders both selectors with their Pinned aria-labels", async () => {
    const { ChatContextBar } = await import("./chat-context-bar");
    const { container } = render(
      <ChatContextBar
        repositories={[REPO]}
        environments={[ENV]}
        selectedRepoKey={null}
        selectedEnvId={null}
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
        isPinned={false}
        onTogglePin={vi.fn()}
      />,
    );
    expect(container.querySelector('[aria-label="Pinned repository"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Pinned environment"]')).not.toBeNull();
  });

  it("disables the pin button when nothing is selected and not pinned", async () => {
    const { ChatContextBar } = await import("./chat-context-bar");
    render(
      <ChatContextBar
        repositories={[REPO]}
        environments={[ENV]}
        selectedRepoKey={null}
        selectedEnvId={null}
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
        isPinned={false}
        onTogglePin={vi.fn()}
      />,
    );
    expect(screen.getByTestId("pin-to-chat")).toBeDisabled();
  });

  it("enables the pin button when a repo is selected", async () => {
    const { ChatContextBar } = await import("./chat-context-bar");
    render(
      <ChatContextBar
        repositories={[REPO]}
        environments={[ENV]}
        selectedRepoKey={REPO.key}
        selectedEnvId={null}
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
        isPinned={false}
        onTogglePin={vi.fn()}
      />,
    );
    expect(screen.getByTestId("pin-to-chat")).not.toBeDisabled();
  });

  it("calls onTogglePin when the pin button is clicked", async () => {
    const onTogglePin = vi.fn();
    const { ChatContextBar } = await import("./chat-context-bar");
    render(
      <ChatContextBar
        repositories={[REPO]}
        environments={[ENV]}
        selectedRepoKey={REPO.key}
        selectedEnvId={null}
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
        isPinned={false}
        onTogglePin={onTogglePin}
      />,
    );
    await userEvent.click(screen.getByTestId("pin-to-chat"));
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("reflects the unpinned state: aria-pressed false and no pinned summary", async () => {
    const { ChatContextBar } = await import("./chat-context-bar");
    render(
      <ChatContextBar
        repositories={[REPO]}
        environments={[ENV]}
        selectedRepoKey={REPO.key}
        selectedEnvId={null}
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
        isPinned={false}
        onTogglePin={vi.fn()}
      />,
    );
    expect(screen.getByTestId("pin-to-chat")).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("pinned-summary")).not.toBeInTheDocument();
  });

  it("shows the pinned summary and aria-pressed true when pinned with a selection", async () => {
    const { ChatContextBar } = await import("./chat-context-bar");
    render(
      <ChatContextBar
        repositories={[REPO]}
        environments={[ENV]}
        selectedRepoKey={REPO.key}
        selectedEnvId={ENV.id}
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
        isPinned
        onTogglePin={vi.fn()}
      />,
    );
    expect(screen.getByTestId("pin-to-chat")).toHaveAttribute("aria-pressed", "true");
    const summary = screen.getByTestId("pinned-summary");
    expect(summary).toBeInTheDocument();
    expect(summary).toHaveTextContent("acme/widgets");
    expect(summary).toHaveTextContent("Default");
  });

  it("does not show the pinned summary when pinned but nothing is selected", async () => {
    const { ChatContextBar } = await import("./chat-context-bar");
    render(
      <ChatContextBar
        repositories={[REPO]}
        environments={[ENV]}
        selectedRepoKey={null}
        selectedEnvId={null}
        onSelectRepo={vi.fn()}
        onSelectEnv={vi.fn()}
        isPinned
        onTogglePin={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("pinned-summary")).not.toBeInTheDocument();
  });

  it("calls onSelectRepo with the matching RepoOption when a repo is chosen", async () => {
    const onSelectRepo = vi.fn();
    const { ChatContextBar } = await import("./chat-context-bar");
    render(
      <ChatContextBar
        repositories={[REPO]}
        environments={[ENV]}
        selectedRepoKey={null}
        selectedEnvId={null}
        onSelectRepo={onSelectRepo}
        onSelectEnv={vi.fn()}
        isPinned={false}
        onTogglePin={vi.fn()}
      />,
    );
    // The repo selector renders before the environment selector, so the first
    // Select shim is the repo one. Clicking it fires onValueChange("acme/widgets").
    const repoSelect = screen.getAllByTestId("select")[0];
    expect(repoSelect).toBeDefined();
    await userEvent.click(repoSelect!);
    expect(onSelectRepo).toHaveBeenCalledWith(
      expect.objectContaining({ key: "acme/widgets", owner: "acme", name: "widgets" }),
    );
  });
});
