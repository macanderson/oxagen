// @vitest-environment jsdom
/**
 * repo-selector.test.tsx
 *
 * Unit tests for RepoSelector:
 *   - Renders "owner/name" for each repo option
 *   - Selecting a repo calls onSelectRepo with the matching RepoOption
 *   - Disabled when isLoading or there are no repositories
 *   - Placeholder shown when nothing is selected
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RepoOption } from "./repo-selector";

afterEach(cleanup);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Minimal Select shim: renders children inside a div whose click fires
// onValueChange with the FIRST rendered item's value — enough to exercise
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
  return { ...real, GitBranch: () => <span data-testid="icon-git-branch" /> };
});

function makeRepo(overrides: Partial<RepoOption> = {}): RepoOption {
  return {
    key: "con_1::acme/widgets",
    connectionId: "con_1",
    owner: "acme",
    name: "widgets",
    defaultBranch: "main",
    ...overrides,
  };
}

describe("RepoSelector", () => {
  it("renders owner/name for each repo", async () => {
    const { RepoSelector } = await import("./repo-selector");
    render(
      <RepoSelector
        repositories={[
          makeRepo(),
          makeRepo({ key: "con_2::acme/gadgets", name: "gadgets" }),
        ]}
        selectedKey={null}
        onSelectRepo={vi.fn()}
      />,
    );
    expect(screen.getByText("acme/widgets")).toBeInTheDocument();
    expect(screen.getByText("acme/gadgets")).toBeInTheDocument();
  });

  it("shows the placeholder when nothing is selected", async () => {
    const { RepoSelector } = await import("./repo-selector");
    render(
      <RepoSelector
        repositories={[makeRepo()]}
        selectedKey={null}
        onSelectRepo={vi.fn()}
      />,
    );
    expect(screen.getByText("Select repository")).toBeInTheDocument();
  });

  it("calls onSelectRepo with the matching RepoOption on selection", async () => {
    const onSelectRepo = vi.fn();
    const { RepoSelector } = await import("./repo-selector");
    render(
      <RepoSelector
        repositories={[makeRepo({ key: "acme/widgets" })]}
        selectedKey={null}
        onSelectRepo={onSelectRepo}
      />,
    );
    await userEvent.click(screen.getByTestId("select"));
    expect(onSelectRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "acme/widgets",
        owner: "acme",
        name: "widgets",
      }),
    );
  });

  it("does not call onSelectRepo when the resolved value matches no repo", async () => {
    const onSelectRepo = vi.fn();
    const { RepoSelector } = await import("./repo-selector");
    render(
      <RepoSelector
        repositories={[makeRepo({ key: "con_9::other/repo" })]}
        selectedKey={null}
        onSelectRepo={onSelectRepo}
      />,
    );
    await userEvent.click(screen.getByTestId("select"));
    expect(onSelectRepo).not.toHaveBeenCalled();
  });

  it("is disabled when isLoading is true", async () => {
    const { RepoSelector } = await import("./repo-selector");
    render(
      <RepoSelector
        repositories={[makeRepo()]}
        selectedKey={null}
        onSelectRepo={vi.fn()}
        isLoading
      />,
    );
    expect(screen.getByTestId("select")).toHaveAttribute(
      "data-disabled",
      "true",
    );
  });

  it("is disabled when there are no repositories", async () => {
    const { RepoSelector } = await import("./repo-selector");
    render(
      <RepoSelector
        repositories={[]}
        selectedKey={null}
        onSelectRepo={vi.fn()}
      />,
    );
    expect(screen.getByTestId("select")).toHaveAttribute(
      "data-disabled",
      "true",
    );
  });

  it("uses a mobile-first full-width trigger with a fixed desktop width", async () => {
    const { RepoSelector } = await import("./repo-selector");
    render(
      <RepoSelector
        repositories={[makeRepo()]}
        selectedKey={null}
        onSelectRepo={vi.fn()}
      />,
    );
    const trigger = screen.getByTestId("select-trigger");
    expect(trigger.className).toContain("w-full");
    expect(trigger.className).toContain("sm:w-48");
    expect(trigger.className).toContain("min-h-11");
  });

  it("appends a caller-supplied className to the trigger", async () => {
    const { RepoSelector } = await import("./repo-selector");
    render(
      <RepoSelector
        repositories={[makeRepo()]}
        selectedKey={null}
        onSelectRepo={vi.fn()}
        className="custom-class"
      />,
    );
    expect(screen.getByTestId("select-trigger").className).toContain(
      "custom-class",
    );
  });
});
