// @vitest-environment jsdom
/**
 * create-org-inline.test.tsx
 *
 * Render + interaction tests for CreateOrgInline:
 *   - Renders form with name and slug inputs
 *   - Pre-fills suggestedName and derives slug
 *   - Shows error when createOrgAction fails
 *   - Shows success state when org is created
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

// Dynamic import in the source — we mock the module
vi.mock("@/app/(onboarding)/new-organization/actions", () => ({
  createOrgAction: vi.fn(),
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
    Building2: vi.fn(() => <span />),
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("CreateOrgInline", () => {
  it("renders form with aria-label 'Create organization'", async () => {
    const { default: CreateOrgInline } = await import("./create-org-inline");
    render(<CreateOrgInline />);
    expect(
      screen.getByRole("form", { name: "Create organization" }),
    ).toBeInTheDocument();
  });

  it("renders Name and Slug inputs", async () => {
    const { default: CreateOrgInline } = await import("./create-org-inline");
    render(<CreateOrgInline />);
    expect(screen.getByPlaceholderText("Acme Inc.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("acme")).toBeInTheDocument();
  });

  it("pre-fills name from suggestedName and derives slug", async () => {
    const { default: CreateOrgInline } = await import("./create-org-inline");
    render(<CreateOrgInline suggestedName="My Company" />);
    const nameInput = screen.getByPlaceholderText(
      "Acme Inc.",
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("My Company");
    const slugInput = screen.getByPlaceholderText("acme") as HTMLInputElement;
    expect(slugInput.value).toBe("my-company");
  });

  it("submit button is disabled when name is empty", async () => {
    const { default: CreateOrgInline } = await import("./create-org-inline");
    render(<CreateOrgInline />);
    expect(
      screen.getByRole("button", { name: "Create organization" }),
    ).toBeDisabled();
  });

  it("shows error when createOrgAction fails", async () => {
    const { createOrgAction } = await import(
      "@/app/(onboarding)/new-organization/actions"
    );
    vi.mocked(createOrgAction).mockResolvedValue({
      ok: false,
      error: "Slug already taken",
    });

    const { default: CreateOrgInline } = await import("./create-org-inline");
    render(<CreateOrgInline suggestedName="Acme Corp" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Create organization" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Slug already taken");
    });
  });

  it("shows success state when org is created", async () => {
    const { createOrgAction } = await import(
      "@/app/(onboarding)/new-organization/actions"
    );
    vi.mocked(createOrgAction).mockResolvedValue({
      ok: true,
      orgSlug: "acme-corp",
      workspaceSlug: "default",
    });
    Object.defineProperty(window, "location", {
      value: { assign: vi.fn() },
      writable: true,
    });

    const { default: CreateOrgInline } = await import("./create-org-inline");
    render(<CreateOrgInline suggestedName="Acme Corp" />);
    await userEvent.click(
      screen.getByRole("button", { name: "Create organization" }),
    );
    await waitFor(() => {
      expect(
        screen.getByText("Organization created — redirecting…"),
      ).toBeInTheDocument();
    });
  });
});
