// @vitest-environment jsdom
/**
 * funding-form.test.tsx — component tests for FundingForm.
 *
 * Covers:
 *   (a) the two funding states — the org's own key (provider, hint,
 *       timestamps) and Oxagen's key
 *   (b) the key input is masked (type=password, autocomplete off)
 *   (c) canEdit=false — controls disabled, permission note shown
 *   (d) Test key calls verifyAction with the candidate and shows the vendor's
 *       verdict; a refusal shows the vendor's text
 *   (e) Save key calls setAction, clears the field, updates the status block
 *   (f) Remove key is a two-step inline confirm (no browser confirm()) and
 *       calls deleteAction only on the second click
 *   (g) the cap form sends cents, and "No cap" sends null
 *
 * Mock seam mirrors general-form.test.tsx: next/navigation, the UI primitives
 * and lucide-react are stubbed; the component under test is real.
 */

import * as React from "react";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockSetAction,
  mockVerifyAction,
  mockDeleteAction,
  mockCapAction,
  mockRefresh,
} = vi.hoisted(() => ({
  mockSetAction: vi.fn(),
  mockVerifyAction: vi.fn(),
  mockDeleteAction: vi.fn(),
  mockCapAction: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: mockRefresh }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    type,
    disabled,
    onClick,
    startIcon: _i,
    variant: _v,
    size: _s,
  }: {
    children: React.ReactNode;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
    onClick?: () => void;
    startIcon?: React.ReactNode;
    variant?: string;
    size?: string;
  }) => (
    <button type={type ?? "button"} disabled={disabled} onClick={onClick}>
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

import { FundingForm } from "./funding-form";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWN_KEY_VIEW = {
  configured: true as const,
  provider: "openrouter" as const,
  status: "active" as const,
  keyHint: "cdef",
  lastVerifiedAt: "2026-09-08T12:00:00.000Z",
  rotatedAt: "2026-09-01T09:30:00.000Z",
};

const PLATFORM_VIEW = {
  configured: false as const,
  provider: null,
  status: null,
  keyHint: null,
  lastVerifiedAt: null,
  rotatedAt: null,
};

const KEY = "sk-or-v1-0123456789abcdef";

const baseProps = {
  orgSlug: "acme",
  canEdit: true,
  capCents: 2500,
  setAction: mockSetAction,
  verifyAction: mockVerifyAction,
  deleteAction: mockDeleteAction,
  capAction: mockCapAction,
};

const keyInput = () => screen.getByLabelText("API key") as HTMLInputElement;
const providerSelect = () =>
  screen.getByLabelText("Provider") as HTMLSelectElement;
const keyForm = () =>
  screen.getByRole("form", { name: /your model vendor key/i });
const capForm = () =>
  screen.getByRole("form", { name: /assistant usage cap/i });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FundingForm", () => {
  afterEach(() => cleanup());
  beforeEach(() => vi.clearAllMocks());

  // (a) Funding states
  it("shows the org's own key with provider, hint and timestamps when configured", () => {
    render(<FundingForm {...baseProps} view={OWN_KEY_VIEW} />);
    const status = screen.getByTestId("funding-status");
    expect(status).toHaveTextContent(/Your key \(OpenRouter, ends in cdef\)/);
    expect(status).toHaveTextContent(/Last verified/);
    expect(status).toHaveTextContent(/Last changed/);
    expect(
      screen.getByRole("button", { name: /remove key/i }),
    ).toBeInTheDocument();
  });

  it("shows Oxagen's key when no credential is stored, and no remove button", () => {
    render(<FundingForm {...baseProps} view={PLATFORM_VIEW} />);
    expect(screen.getByTestId("funding-status")).toHaveTextContent(
      /Oxagen’s key — assistant usage is billed to your credits/,
    );
    expect(
      screen.queryByRole("button", { name: /remove key/i }),
    ).not.toBeInTheDocument();
  });

  it("explains that the cap does not apply while your own key is stored, and that OpenRouter does not cover embeddings", () => {
    render(<FundingForm {...baseProps} view={PLATFORM_VIEW} />);
    expect(
      screen.getByText(/does not apply while your own key is stored/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/OpenRouter key covers chat models only/i),
    ).toBeInTheDocument();
  });

  // (b) Masked, write-only key input
  it("renders the key input masked with autocomplete off and never pre-fills it", () => {
    render(<FundingForm {...baseProps} view={OWN_KEY_VIEW} />);
    const input = keyInput();
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.value).toBe("");
  });

  // (c) canEdit=false
  it("disables every control and shows the permission note when canEdit is false", () => {
    render(<FundingForm {...baseProps} view={null} canEdit={false} />);
    expect(screen.getByRole("note")).toHaveTextContent(/owners and admins/i);
    expect(keyInput()).toBeDisabled();
    expect(providerSelect()).toBeDisabled();
    expect(screen.getByRole("button", { name: /save key/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /save cap/i })).toBeDisabled();
  });

  // (d) Test key
  it("calls verifyAction with the candidate provider and key, and shows the accepted latency", async () => {
    mockVerifyAction.mockResolvedValue({
      ok: true,
      verification: {
        ok: true,
        provider: "gateway",
        latencyMs: 123,
        error: null,
      },
    });
    render(<FundingForm {...baseProps} view={PLATFORM_VIEW} />);

    fireEvent.change(providerSelect(), { target: { value: "gateway" } });
    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /^test key$/i }));

    await waitFor(() => expect(mockVerifyAction).toHaveBeenCalledOnce());
    expect(mockVerifyAction).toHaveBeenCalledWith({
      provider: "gateway",
      apiKey: KEY,
    });
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /Vercel AI Gateway accepted the key \(123 ms\)/,
      ),
    );
  });

  it("shows the vendor's own error text when the key is rejected", async () => {
    mockVerifyAction.mockResolvedValue({
      ok: true,
      verification: {
        ok: false,
        provider: "openrouter",
        latencyMs: 88,
        error: "Invalid API key",
      },
    });
    render(<FundingForm {...baseProps} view={PLATFORM_VIEW} />);

    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.click(screen.getByRole("button", { name: /^test key$/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /OpenRouter rejected the key: Invalid API key/,
      ),
    );
    expect(mockSetAction).not.toHaveBeenCalled();
  });

  it("tests the stored key with no input when the field is empty and a key is configured", async () => {
    mockVerifyAction.mockResolvedValue({
      ok: true,
      verification: {
        ok: true,
        provider: "openrouter",
        latencyMs: 50,
        error: null,
      },
    });
    render(<FundingForm {...baseProps} view={OWN_KEY_VIEW} />);

    fireEvent.click(screen.getByRole("button", { name: /test stored key/i }));

    await waitFor(() => expect(mockVerifyAction).toHaveBeenCalledWith({}));
  });

  // (e) Save key
  it("calls setAction on submit, clears the field and switches the status block to your key", async () => {
    mockSetAction.mockResolvedValue({ ok: true, view: OWN_KEY_VIEW });
    render(<FundingForm {...baseProps} view={PLATFORM_VIEW} />);

    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.submit(keyForm());

    await waitFor(() => expect(mockSetAction).toHaveBeenCalledOnce());
    expect(mockSetAction).toHaveBeenCalledWith({
      provider: "openrouter",
      apiKey: KEY,
    });
    await waitFor(() => expect(keyInput().value).toBe(""));
    expect(screen.getByTestId("funding-status")).toHaveTextContent(
      /Your key \(OpenRouter, ends in cdef\)/,
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("shows the action's error when saving fails", async () => {
    mockSetAction.mockResolvedValue({
      ok: false,
      error: "Saving the key failed. Test it first, then try again.",
    });
    render(<FundingForm {...baseProps} view={PLATFORM_VIEW} />);

    fireEvent.change(keyInput(), { target: { value: KEY } });
    fireEvent.submit(keyForm());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Saving the key failed/,
      ),
    );
  });

  // (f) Remove key — inline two-step confirm
  it("asks for confirmation inline and calls deleteAction only on the second click", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    mockDeleteAction.mockResolvedValue({ ok: true, view: PLATFORM_VIEW });
    render(<FundingForm {...baseProps} view={OWN_KEY_VIEW} />);

    fireEvent.click(screen.getByRole("button", { name: /^remove key$/i }));
    expect(mockDeleteAction).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Remove your key and switch to/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /confirm remove/i }));

    await waitFor(() => expect(mockDeleteAction).toHaveBeenCalledOnce());
    expect(confirmSpy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId("funding-status")).toHaveTextContent(
        /Oxagen’s key/,
      ),
    );
    confirmSpy.mockRestore();
  });

  it("cancels the inline confirm without calling deleteAction", () => {
    render(<FundingForm {...baseProps} view={OWN_KEY_VIEW} />);

    fireEvent.click(screen.getByRole("button", { name: /^remove key$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(mockDeleteAction).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /^remove key$/i }),
    ).toBeInTheDocument();
  });

  // (g) Cap
  it("pre-fills the cap in credits and submits it as cents", async () => {
    mockCapAction.mockResolvedValue({ ok: true, capCents: 4000 });
    render(<FundingForm {...baseProps} view={PLATFORM_VIEW} capCents={2500} />);

    const cap = screen.getByLabelText(
      /cap \(credits per month\)/i,
    ) as HTMLInputElement;
    expect(cap.value).toBe("25.00");

    fireEvent.change(cap, { target: { value: "40" } });
    fireEvent.submit(capForm());

    await waitFor(() => expect(mockCapAction).toHaveBeenCalledWith(4000));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Saved"),
    );
  });

  it("submits null when No cap is checked", async () => {
    mockCapAction.mockResolvedValue({ ok: true, capCents: null });
    render(<FundingForm {...baseProps} view={PLATFORM_VIEW} capCents={2500} />);

    fireEvent.click(screen.getByLabelText(/no cap/i));
    fireEvent.submit(capForm());

    await waitFor(() => expect(mockCapAction).toHaveBeenCalledWith(null));
  });

  it("starts with No cap checked when the cap is null", () => {
    render(<FundingForm {...baseProps} view={PLATFORM_VIEW} capCents={null} />);
    expect(screen.getByLabelText(/no cap/i)).toBeChecked();
    expect(screen.getByLabelText(/cap \(credits per month\)/i)).toBeDisabled();
  });
});
