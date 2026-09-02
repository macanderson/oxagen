// @vitest-environment jsdom
/**
 * general-form.test.tsx — component tests for OrgGeneralForm.
 *
 * Covers:
 *   (a) Initial render — form renders with aria-label, name and slug inputs.
 *   (b) canEdit=false — inputs are disabled, save button disabled, permission note visible.
 *   (c) Name change auto-derives slug when slug is empty.
 *   (d) Name change does NOT overwrite a non-empty slug.
 *   (e) Happy path — submit calls action with correct FormData values, no error shown.
 *   (f) Slug-changed path — router.replace is called with the new slug.
 *   (g) Same-slug path — router.refresh is called instead.
 *   (h) Error path — action returns ok:false, shows error alert.
 *   (i) useRegisterFillableForm is called (formId + fields captured).
 *   (j) Apply round-trip: apply({ name, slug }) updates controlled state.
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
  mockRefresh,
  mockUseRegisterFillableForm,
  mockUseRegisterPageEntity,
} = vi.hoisted(() => ({
  mockAction: vi.fn(),
  mockReplace: vi.fn(),
  mockRefresh: vi.fn(),
  mockUseRegisterFillableForm: vi.fn(),
  mockUseRegisterPageEntity: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, refresh: mockRefresh }),
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

vi.mock("@/components/ui/label", () => ({
  Label: ({
    children,
    htmlFor,
  }: {
    children: React.ReactNode;
    htmlFor?: string;
  }) => <label htmlFor={htmlFor}>{children}</label>,
}));

vi.mock("@/components/avatar/avatar-maker", () => ({
  AvatarMaker: ({
    value,
    onChange,
    disabled,
  }: {
    value: string | null;
    onChange: (url: string) => void;
    disabled?: boolean;
    name?: string;
    shape?: string;
    entityLabel?: string;
  }) => (
    <button
      type="button"
      data-testid="avatar-upload"
      data-value={value}
      disabled={disabled}
      onClick={() => onChange("https://cdn.example.com/avatar.png")}
    >
      Upload
    </button>
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

import { OrgGeneralForm } from "./general-form";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let capturedApply: ((proposed: Record<string, unknown>) => void) | null = null;

const defaultProps = {
  orgSlug: "acme",
  initialName: "Acme Corp",
  initialSlug: "acme",
  initialAvatarUrl: "",
  canEdit: true,
  action: mockAction,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrgGeneralForm", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    capturedApply = null;
    mockUseRegisterFillableForm.mockImplementation(
      (spec: { apply: (proposed: Record<string, unknown>) => void }) => {
        capturedApply = spec.apply;
      },
    );
    mockUseRegisterPageEntity.mockImplementation(() => undefined);
  });

  // (a) Initial render
  it("renders with the aria-label and both name/slug inputs", () => {
    render(<OrgGeneralForm {...defaultProps} />);

    expect(
      screen.getByRole("form", { name: /organization general settings/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Organization name")).toBeInTheDocument();
    expect(screen.getByLabelText("Slug")).toBeInTheDocument();
  });

  // (b) canEdit=false
  it("disables name and slug inputs and shows permission note when canEdit is false", () => {
    render(<OrgGeneralForm {...defaultProps} canEdit={false} />);

    expect(screen.getByLabelText("Organization name")).toBeDisabled();
    expect(screen.getByLabelText("Slug")).toBeDisabled();
    expect(screen.getByRole("note")).toBeInTheDocument();
  });

  it("disables the save button when canEdit is false", () => {
    render(<OrgGeneralForm {...defaultProps} canEdit={false} />);

    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeDisabled();
  });

  // (c) Auto-derive slug from name when slug is empty
  it("derives slug from name when slug is empty", () => {
    render(<OrgGeneralForm {...defaultProps} initialName="" initialSlug="" />);

    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "My New Org" },
    });

    const slugInput = screen.getByLabelText("Slug") as HTMLInputElement;
    expect(slugInput.value).toBe("my-new-org");
  });

  // (d) Non-empty slug is not overwritten when name changes
  it("does not overwrite a non-empty slug when the name changes", () => {
    render(<OrgGeneralForm {...defaultProps} />);

    fireEvent.change(screen.getByLabelText("Organization name"), {
      target: { value: "New Name" },
    });

    const slugInput = screen.getByLabelText("Slug") as HTMLInputElement;
    // initialSlug="acme" is non-empty, so it should stay
    expect(slugInput.value).toBe("acme");
  });

  // (e) Happy path — same slug
  it("calls action with correct FormData values on submit (same-slug path)", async () => {
    mockAction.mockResolvedValue({ ok: true, slug: "acme" });

    render(<OrgGeneralForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /organization general settings/i }),
    );

    await waitFor(() => {
      expect(mockAction).toHaveBeenCalledOnce();
    });

    const [formData] = mockAction.mock.calls[0] as [FormData];
    expect(formData.get("name")).toBe("Acme Corp");
    expect(formData.get("slug")).toBe("acme");
  });

  // (f) Slug-changed path — router.replace called
  it("calls router.replace when the returned slug differs from the current orgSlug", async () => {
    mockAction.mockResolvedValue({ ok: true, slug: "acme-new" });

    render(<OrgGeneralForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /organization general settings/i }),
    );

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledOnce();
    });

    expect(mockReplace).toHaveBeenCalledWith("/acme-new/settings/general");
  });

  // (g) Same-slug path — router.refresh called
  it("calls router.refresh when the returned slug matches the current orgSlug", async () => {
    mockAction.mockResolvedValue({ ok: true, slug: "acme" });

    render(<OrgGeneralForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /organization general settings/i }),
    );

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledOnce();
    });

    expect(mockReplace).not.toHaveBeenCalled();
  });

  // (h) Error path
  it("shows an error alert when action returns ok:false", async () => {
    mockAction.mockResolvedValue({ ok: false, error: "Slug already taken" });

    render(<OrgGeneralForm {...defaultProps} />);

    fireEvent.submit(
      screen.getByRole("form", { name: /organization general settings/i }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Slug already taken");
  });

  // (i) useRegisterFillableForm called
  it("registers the fillable form with the correct formId", () => {
    render(<OrgGeneralForm {...defaultProps} />);

    expect(mockUseRegisterFillableForm).toHaveBeenCalledWith(
      expect.objectContaining({ formId: "org-general-acme" }),
    );
  });

  // (j) Apply round-trip
  it("apply({ name, slug }) updates controlled name and slug state", async () => {
    mockAction.mockResolvedValue({ ok: true, slug: "proposed-slug" });

    render(<OrgGeneralForm {...defaultProps} />);

    expect(capturedApply).not.toBeNull();

    act(() => {
      capturedApply!({ name: "Proposed Name", slug: "proposed-slug" });
    });

    fireEvent.submit(
      screen.getByRole("form", { name: /organization general settings/i }),
    );

    await waitFor(() => {
      expect(mockAction).toHaveBeenCalledOnce();
    });

    const [formData] = mockAction.mock.calls[0] as [FormData];
    expect(formData.get("name")).toBe("Proposed Name");
    expect(formData.get("slug")).toBe("proposed-slug");
  });

  // Avatar URL included in FormData
  it("includes updated avatarUrl in FormData after AvatarUpload onChange", async () => {
    mockAction.mockResolvedValue({ ok: true, slug: "acme" });

    render(<OrgGeneralForm {...defaultProps} />);

    // Click the stub AvatarUpload button to trigger onChange
    fireEvent.click(screen.getByTestId("avatar-upload"));

    fireEvent.submit(
      screen.getByRole("form", { name: /organization general settings/i }),
    );

    await waitFor(() => {
      expect(mockAction).toHaveBeenCalledOnce();
    });

    const [formData] = mockAction.mock.calls[0] as [FormData];
    expect(formData.get("avatarUrl")).toBe(
      "https://cdn.example.com/avatar.png",
    );
  });
});
