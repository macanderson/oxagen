// @vitest-environment jsdom
/**
 * workspace-general-form.test.tsx — component tests for WorkspaceGeneralForm.
 *
 * Covers:
 *   (a) Initial render — form renders with aria-label, name + slug + description inputs.
 *   (b) Name change auto-derives slug when slug is empty.
 *   (c) Name change does NOT overwrite a non-empty slug.
 *   (d) Slug input normalizes to a slug-safe value (slugify applied).
 *   (e) useRegisterFillableForm is called (formId captured).
 *   (f) apply({ name, slug, description }) updates controlled state; reflected on submit.
 *   (g) Happy path (same slug) — action called, saved-at indicator shown.
 *   (h) Slug-changed path — router.replace called with new path.
 *   (i) Save button disabled while name or slug is empty.
 *   (j) Errors do NOT crash the form (action throws → form still renders).
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

const {
  mockAction,
  mockReplace,
  mockUseRegisterFillableForm,
  mockUseRegisterPageEntity,
} = vi.hoisted(() => ({
  mockAction: vi.fn(),
  mockReplace: vi.fn(),
  mockUseRegisterFillableForm: vi.fn(),
  mockUseRegisterPageEntity: vi.fn(),
}));

vi.mock("./actions", () => ({
  updateWorkspaceGeneralAction: mockAction,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("@/lib/page-context", () => ({
  useRegisterFillableForm: mockUseRegisterFillableForm,
  useRegisterPageEntity: mockUseRegisterPageEntity,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type,
    disabled,
    startIcon: _i,
    variant: _v,
    size: _s,
  }: {
    children: React.ReactNode;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    startIcon?: React.ReactNode;
    variant?: string;
    size?: string;
  }) => (
    <button type={type ?? "button"} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input {...props} />
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

vi.mock(
  "lucide-react",
  () =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : () => <svg aria-hidden="true" data-icon={String(prop)} />,
      has: (_t, prop) => prop !== "then",
    }),
);

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { WorkspaceGeneralForm } from "./workspace-general-form";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let capturedApply:
  | ((
      proposed: Record<string, unknown>,
      mode: "field" | "all",
      fieldName?: string,
    ) => void)
  | null = null;

const defaultProps = {
  orgSlug: "acme",
  workspaceSlug: "research",
  workspaceId: "ws-1",
  initialName: "Research",
  initialSlug: "research",
  initialDescription: "Main research workspace.",
  initialAvatarUrl: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceGeneralForm", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    capturedApply = null;
    mockUseRegisterFillableForm.mockImplementation(
      (spec: {
        apply: (
          proposed: Record<string, unknown>,
          mode: "field" | "all",
          fieldName?: string,
        ) => void;
      }) => {
        capturedApply = spec.apply;
      },
    );
    mockUseRegisterPageEntity.mockImplementation(() => undefined);
  });

  // (a) Initial render
  it("renders with aria-label and all three inputs", () => {
    render(<WorkspaceGeneralForm {...defaultProps} />);

    expect(
      screen.getByRole("form", { name: /workspace general settings/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/workspace name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/workspace slug/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
  });

  // (b) Auto-derive slug from name when slug is empty
  it("derives slug from name when slug field is cleared and name changes", () => {
    render(
      <WorkspaceGeneralForm {...defaultProps} initialSlug="" initialName="" />,
    );

    fireEvent.change(screen.getByLabelText(/workspace name/i), {
      target: { value: "Analytics Team" },
    });

    const slugInput = screen.getByLabelText(
      /workspace slug/i,
    ) as HTMLInputElement;
    expect(slugInput.value).toBe("analytics-team");
  });

  // (c) Non-empty slug is not overwritten
  it("does not overwrite a non-empty slug when name changes", () => {
    render(<WorkspaceGeneralForm {...defaultProps} />);

    fireEvent.change(screen.getByLabelText(/workspace name/i), {
      target: { value: "New Name" },
    });

    const slugInput = screen.getByLabelText(
      /workspace slug/i,
    ) as HTMLInputElement;
    // initialSlug="research" is non-empty — must not be overwritten
    expect(slugInput.value).toBe("research");
  });

  // (d) Slug input normalizes raw input
  it("normalizes slug input to a slug-safe value", () => {
    render(<WorkspaceGeneralForm {...defaultProps} />);

    fireEvent.change(screen.getByLabelText(/workspace slug/i), {
      target: { value: "My Team 2026!" },
    });

    const slugInput = screen.getByLabelText(
      /workspace slug/i,
    ) as HTMLInputElement;
    // slugify("My Team 2026!") should produce "my-team-2026"
    expect(slugInput.value).toMatch(/^[a-z0-9-]+$/);
    expect(slugInput.value).not.toContain("!");
    expect(slugInput.value).not.toContain(" ");
  });

  // (e) useRegisterFillableForm called
  it("registers the fillable form", () => {
    render(<WorkspaceGeneralForm {...defaultProps} />);
    expect(mockUseRegisterFillableForm).toHaveBeenCalledOnce();
  });

  // (f) Apply round-trip
  it("apply({ name, slug, description }) updates state and is reflected on submit", async () => {
    mockAction.mockResolvedValue({ ok: true, slug: "new-slug" });

    render(<WorkspaceGeneralForm {...defaultProps} />);

    expect(capturedApply).not.toBeNull();

    act(() => {
      capturedApply!(
        { name: "Proposed", slug: "new-slug", description: "New desc" },
        "all",
      );
    });

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace general settings/i }),
    );

    await waitFor(() => {
      expect(mockAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockAction.mock.calls[0] as [
      { name: string; slug: string; description?: string },
    ];
    expect(arg.name).toBe("Proposed");
    expect(arg.slug).toBe("new-slug");
    expect(arg.description).toBe("New desc");
  });

  // (g) Happy path — same slug shows saved-at
  it("shows saved-at indicator after a successful save (same-slug path)", async () => {
    mockAction.mockResolvedValue({ ok: true, slug: "research" });

    render(<WorkspaceGeneralForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace general settings/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/saved at/i)).toBeInTheDocument();
    });

    expect(mockReplace).not.toHaveBeenCalled();
  });

  // (h) Slug-changed path — router.replace called
  it("calls router.replace when the returned slug differs", async () => {
    mockAction.mockResolvedValue({ ok: true, slug: "research-v2" });

    render(<WorkspaceGeneralForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace general settings/i }),
    );

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledOnce();
    });

    expect(mockReplace).toHaveBeenCalledWith(
      "/acme/research-v2/settings/general",
    );
  });

  // (i) Save button disabled when name or slug is empty
  it("disables the save button when name is empty", () => {
    render(
      <WorkspaceGeneralForm {...defaultProps} initialName="" initialSlug="" />,
    );

    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeDisabled();
  });

  it("disables the save button when slug is empty", () => {
    render(<WorkspaceGeneralForm {...defaultProps} initialSlug="" />);

    // Name is non-empty ("Research") but slug is empty
    const slugInput = screen.getByLabelText(
      /workspace slug/i,
    ) as HTMLInputElement;
    // It might have auto-seeded the slug from name focus; clear it explicitly
    fireEvent.change(slugInput, { target: { value: "" } });

    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeDisabled();
  });

  // (j) Action throws — form does not crash
  it("does not crash the form when the action throws", async () => {
    mockAction.mockRejectedValue(new Error("Network error"));

    render(<WorkspaceGeneralForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace general settings/i }),
    );

    // Form should still be in the DOM after the throw
    await waitFor(() => {
      expect(
        screen.getByRole("form", { name: /workspace general settings/i }),
      ).toBeInTheDocument();
    });
  });

  // orgSlug and workspaceSlug passed to action correctly
  it("passes correct orgSlug and workspaceSlug to the action", async () => {
    mockAction.mockResolvedValue({ ok: true, slug: "research" });

    render(<WorkspaceGeneralForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /workspace general settings/i }),
    );

    await waitFor(() => {
      expect(mockAction).toHaveBeenCalledOnce();
    });

    const [arg] = mockAction.mock.calls[0] as [
      { orgSlug: string; workspaceSlug: string },
    ];
    expect(arg.orgSlug).toBe("acme");
    expect(arg.workspaceSlug).toBe("research");
  });
});
