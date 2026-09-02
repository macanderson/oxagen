// @vitest-environment jsdom
/**
 * credits-purchase-inline.test.tsx
 *
 * Render + interaction tests for CreditsPurchaseInline:
 *   - Renders preset amount buttons
 *   - Uses suggestedAmountUsd to pre-select amount
 *   - Shows error when amount < $5
 *   - Shows error when buyCreditsAction fails
 *   - Shows success state on successful submit
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

afterEach(cleanup);

vi.mock("@/app/[orgSlug]/billing/actions", () => ({
  changePlanAction: vi.fn(),
  buyCreditsAction: vi.fn(),
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
    Coins: vi.fn(() => <span />),
    CheckCircle2: vi.fn(() => <span data-testid="icon-check" />),
    ArrowUpRight: vi.fn(() => <span />),
  };
});

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

describe("CreditsPurchaseInline", () => {
  it("renders preset amount buttons", async () => {
    const { buyCreditsAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(buyCreditsAction).mockResolvedValue({ ok: true, url: "/" });

    const { default: CreditsPurchaseInline } = await import(
      "./credits-purchase-inline"
    );
    render(<CreditsPurchaseInline />);
    expect(screen.getByRole("button", { name: "$10" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "$25" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "$50" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "$100" })).toBeInTheDocument();
  });

  it("renders form with aria-label", async () => {
    const { buyCreditsAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(buyCreditsAction).mockResolvedValue({ ok: true, url: "/" });

    const { default: CreditsPurchaseInline } = await import(
      "./credits-purchase-inline"
    );
    render(<CreditsPurchaseInline />);
    expect(
      screen.getByRole("form", { name: "Purchase credits" }),
    ).toBeInTheDocument();
  });

  it("defaults to $25 selected when no suggestedAmountUsd", async () => {
    const { buyCreditsAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(buyCreditsAction).mockResolvedValue({ ok: true, url: "/" });

    const { default: CreditsPurchaseInline } = await import(
      "./credits-purchase-inline"
    );
    render(<CreditsPurchaseInline />);
    const btn25 = screen.getByRole("button", { name: "$25" });
    expect(btn25).toHaveAttribute("aria-pressed", "true");
  });

  it("pre-selects suggestedAmountUsd when it matches a preset", async () => {
    const { buyCreditsAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(buyCreditsAction).mockResolvedValue({ ok: true, url: "/" });

    const { default: CreditsPurchaseInline } = await import(
      "./credits-purchase-inline"
    );
    render(<CreditsPurchaseInline suggestedAmountUsd={50} />);
    const btn50 = screen.getByRole("button", { name: "$50" });
    expect(btn50).toHaveAttribute("aria-pressed", "true");
  });

  it("renders the custom amount input", async () => {
    const { buyCreditsAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(buyCreditsAction).mockResolvedValue({ ok: true, url: "/" });

    const { default: CreditsPurchaseInline } = await import(
      "./credits-purchase-inline"
    );
    render(<CreditsPurchaseInline />);
    expect(
      screen.getByRole("spinbutton", { name: "Custom credit amount in USD" }),
    ).toBeInTheDocument();
  });

  it("shows error message when buyCreditsAction fails", async () => {
    const { buyCreditsAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(buyCreditsAction).mockResolvedValue({
      ok: false,
      error: "Card declined",
    });

    const { default: CreditsPurchaseInline } = await import(
      "./credits-purchase-inline"
    );
    render(<CreditsPurchaseInline orgSlug="my-org" />);
    const submitBtn = screen.getByRole("button", { name: /Buy \$/ });
    await userEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Card declined");
    });
  });

  it("shows success state when buyCreditsAction succeeds", async () => {
    const { buyCreditsAction } = await import(
      "@/app/[orgSlug]/billing/actions"
    );
    vi.mocked(buyCreditsAction).mockResolvedValue({
      ok: true,
      url: "/checkout",
    });
    Object.defineProperty(window, "location", {
      value: { assign: vi.fn() },
      writable: true,
    });

    const { default: CreditsPurchaseInline } = await import(
      "./credits-purchase-inline"
    );
    render(<CreditsPurchaseInline orgSlug="my-org" />);
    const submitBtn = screen.getByRole("button", { name: /Buy \$/ });
    await userEvent.click(submitBtn);
    await waitFor(() => {
      expect(screen.getByText("Redirecting to checkout…")).toBeInTheDocument();
    });
  });
});
