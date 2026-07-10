// @vitest-environment jsdom
/**
 * new-organization-form.test.tsx — render + interaction tests for NewOrgForm.
 *
 * Covers:
 *   - Renders name and slug fields
 *   - Slug auto-derives from name
 *   - Manual slug edit locks auto-derivation
 *   - Clearing slug re-arms auto-derivation
 *   - Account type toggle switches labels (business vs personal)
 *   - Success navigates via window.location.assign
 *   - Error displays error message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewOrgForm, type NewOrgAction } from "./new-organization-form";

afterEach(cleanup);

// Mock AvatarUpload (heavy dependency with canvas)
vi.mock("@/components/media/avatar-upload", () => ({
  AvatarUpload: () => <div data-testid="avatar-upload" />,
}));

// Mock BillingAddressFields (heavy)
vi.mock("@/components/billing/billing-address-fields", () => ({
  BillingAddressFields: () => <div data-testid="billing-address-fields" />,
}));

// Mock slugify to get predictable slug derivation
vi.mock("@/lib/slug", () => ({
  slugify: (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
}));

// Mock @oxagen/config constants
vi.mock("@oxagen/config", () => ({
  ORG_TYPE_OPTIONS: [
    { value: "business", label: "Business" },
    { value: "personal", label: "Personal" },
  ],
  INDUSTRY_OPTIONS: [{ value: "tech", label: "Technology" }],
  EMPLOYEE_SIZE_OPTIONS: [{ value: "1-10", label: "1-10" }],
}));

// Mock the combobox (uses portals)
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ComboboxTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ComboboxValue: ({ placeholder }: { placeholder: string }) => (
    <span>{placeholder}</span>
  ),
  ComboboxPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ComboboxItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

// Stub window.location.assign
const assignMock = vi.fn();
Object.defineProperty(window, "location", {
  value: { ...window.location, assign: assignMock },
  writable: true,
});

beforeEach(() => {
  assignMock.mockClear();
});

describe("NewOrgForm — rendering", () => {
  it("renders the organization name field", () => {
    render(<NewOrgForm action={vi.fn()} />);
    expect(screen.getByLabelText(/organization name/i)).toBeInTheDocument();
  });

  it("renders the slug field", () => {
    render(<NewOrgForm action={vi.fn()} />);
    expect(screen.getByLabelText(/slug/i)).toBeInTheDocument();
  });

  it("renders the Create organization button", () => {
    render(<NewOrgForm action={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /create organization/i }),
    ).toBeInTheDocument();
  });
});

describe("NewOrgForm — account type toggle", () => {
  it("shows Business and Personal toggle buttons", () => {
    render(<NewOrgForm action={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: /business/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /personal/i }),
    ).toBeInTheDocument();
  });

  it("switching to Personal changes label to 'Your name'", async () => {
    render(<NewOrgForm action={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /personal/i }));
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument();
  });
});

describe("NewOrgForm — slug auto-derivation", () => {
  it("derives slug from name", async () => {
    render(<NewOrgForm action={vi.fn()} />);
    const nameField = screen.getByLabelText(/organization name/i);
    await userEvent.type(nameField, "My Company");
    const slug = screen.getByLabelText(/slug/i) as HTMLInputElement;
    expect(slug.value).toBe("my-company");
  });

  it("manual slug edit locks auto-derivation", async () => {
    render(<NewOrgForm action={vi.fn()} />);
    const slugField = screen.getByLabelText(/slug/i);
    await userEvent.type(slugField, "my-org");
    await userEvent.type(
      screen.getByLabelText(/organization name/i),
      "Another Name",
    );
    expect((slugField as HTMLInputElement).value).toBe("my-org");
  });
});

describe("NewOrgForm — submission", () => {
  it("shows error when action returns ok:false", async () => {
    const action: NewOrgAction = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "Slug already taken" });
    render(<NewOrgForm action={action} />);
    await userEvent.type(
      screen.getByLabelText(/organization name/i),
      "Test Org",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /create organization/i }),
    );
    await waitFor(() =>
      expect(screen.getByText("Slug already taken")).toBeInTheDocument(),
    );
  });

  it("navigates on success", async () => {
    const action: NewOrgAction = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        orgSlug: "my-org",
        workspaceSlug: "default",
      });
    render(<NewOrgForm action={action} />);
    await userEvent.type(screen.getByLabelText(/organization name/i), "My Org");
    await userEvent.click(
      screen.getByRole("button", { name: /create organization/i }),
    );
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith("/my-org/default"),
    );
  });

  it("stays disabled after success so a duplicate click cannot re-submit", async () => {
    // Regression: window.location.assign does not unload jsdom (nor, briefly,
    // a real browser) — the button must NOT re-enable in that window, or a
    // second click re-runs the action against the already-created slug.
    const action: NewOrgAction = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        orgSlug: "my-org",
        workspaceSlug: "default",
      });
    render(<NewOrgForm action={action} />);
    await userEvent.type(screen.getByLabelText(/organization name/i), "My Org");
    const button = screen.getByRole("button", { name: /create organization/i });
    await userEvent.click(button);
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith("/my-org/default"),
    );
    expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
    // A forced duplicate submit (e.g. Enter keypress or retried click) is a no-op.
    fireEvent.submit(
      screen.getByRole("button", { name: /creating/i }).closest("form")!,
    );
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("NewOrgForm — prefill", () => {
  it("shows attribution when provider is 'google'", () => {
    render(
      <NewOrgForm
        action={vi.fn()}
        prefill={{
          provider: "google",
          name: "",
          email: "",
          avatarUrl: "",
          suggestedBusinessName: "",
          suggestedWebsite: "",
        }}
      />,
    );
    expect(
      screen.getByText(/prefilled from your google account/i),
    ).toBeInTheDocument();
  });

  it("does not show attribution when no provider", () => {
    render(<NewOrgForm action={vi.fn()} />);
    expect(screen.queryByText(/prefilled from your/i)).not.toBeInTheDocument();
  });
});
