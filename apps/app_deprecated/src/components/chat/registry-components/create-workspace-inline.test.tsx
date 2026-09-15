// @vitest-environment jsdom
/**
 * create-workspace-inline.test.tsx
 *
 * Render + interaction tests for CreateWorkspaceInline:
 *   - Renders name and slug inputs
 *   - Auto-derives slug from name
 *   - Shows error when action fails
 *   - Shows success state when workspace is created
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

vi.mock("@/app/actions/create-workspace.action", () => ({
  createWorkspaceInlineAction: vi.fn(),
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

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    FolderPlus: vi.fn(() => <span />),
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("CreateWorkspaceInline", () => {
  it("renders form with aria-label", async () => {
    const { createWorkspaceInlineAction } = await import(
      "@/app/actions/create-workspace.action"
    );
    vi.mocked(createWorkspaceInlineAction).mockResolvedValue({
      ok: true,
      workspaceSlug: "test",
    });

    const { default: CreateWorkspaceInline } = await import(
      "./create-workspace-inline"
    );
    render(<CreateWorkspaceInline />);
    expect(
      screen.getByRole("form", { name: "Create workspace" }),
    ).toBeInTheDocument();
  });

  it("renders Name and Slug inputs", async () => {
    const { createWorkspaceInlineAction } = await import(
      "@/app/actions/create-workspace.action"
    );
    vi.mocked(createWorkspaceInlineAction).mockResolvedValue({
      ok: true,
      workspaceSlug: "test",
    });

    const { default: CreateWorkspaceInline } = await import(
      "./create-workspace-inline"
    );
    render(<CreateWorkspaceInline />);
    expect(screen.getByPlaceholderText("Production")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("production")).toBeInTheDocument();
  });

  it("pre-fills name and slug when suggestedName is provided", async () => {
    const { createWorkspaceInlineAction } = await import(
      "@/app/actions/create-workspace.action"
    );
    vi.mocked(createWorkspaceInlineAction).mockResolvedValue({
      ok: true,
      workspaceSlug: "test",
    });

    const { default: CreateWorkspaceInline } = await import(
      "./create-workspace-inline"
    );
    render(<CreateWorkspaceInline suggestedName="My Workspace" />);
    const nameInput = screen.getByPlaceholderText(
      "Production",
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("My Workspace");
    const slugInput = screen.getByPlaceholderText(
      "production",
    ) as HTMLInputElement;
    expect(slugInput.value).toBe("my-workspace");
  });

  it("submit button is disabled when name is empty", async () => {
    const { createWorkspaceInlineAction } = await import(
      "@/app/actions/create-workspace.action"
    );
    vi.mocked(createWorkspaceInlineAction).mockResolvedValue({
      ok: true,
      workspaceSlug: "test",
    });

    const { default: CreateWorkspaceInline } = await import(
      "./create-workspace-inline"
    );
    render(<CreateWorkspaceInline />);
    expect(
      screen.getByRole("button", { name: "Create workspace" }),
    ).toBeDisabled();
  });

  it("shows error when action fails", async () => {
    const { createWorkspaceInlineAction } = await import(
      "@/app/actions/create-workspace.action"
    );
    vi.mocked(createWorkspaceInlineAction).mockResolvedValue({
      ok: false,
      error: "Slug already taken",
    });

    const { default: CreateWorkspaceInline } = await import(
      "./create-workspace-inline"
    );
    render(
      <CreateWorkspaceInline suggestedName="My Workspace" orgSlug="my-org" />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create workspace" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Slug already taken");
    });
  });

  it("shows success state when workspace is created", async () => {
    const { createWorkspaceInlineAction } = await import(
      "@/app/actions/create-workspace.action"
    );
    vi.mocked(createWorkspaceInlineAction).mockResolvedValue({
      ok: true,
      workspaceSlug: "my-workspace",
    });

    const { default: CreateWorkspaceInline } = await import(
      "./create-workspace-inline"
    );
    render(
      <CreateWorkspaceInline suggestedName="My Workspace" orgSlug="my-org" />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create workspace" }),
    );
    await waitFor(() => {
      expect(screen.getByText("Workspace created")).toBeInTheDocument();
    });
  });

  it("shows workspace slug in success summary", async () => {
    const { createWorkspaceInlineAction } = await import(
      "@/app/actions/create-workspace.action"
    );
    vi.mocked(createWorkspaceInlineAction).mockResolvedValue({
      ok: true,
      workspaceSlug: "my-workspace",
    });

    const { default: CreateWorkspaceInline } = await import(
      "./create-workspace-inline"
    );
    render(
      <CreateWorkspaceInline suggestedName="My Workspace" orgSlug="test-org" />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create workspace" }),
    );
    await waitFor(() => {
      expect(screen.getByText(/\/test-org\/my-workspace/)).toBeInTheDocument();
    });
  });
});
