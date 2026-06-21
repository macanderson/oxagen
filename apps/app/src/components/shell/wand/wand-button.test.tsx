// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";

let mockPathname = "/acme/prod/dashboard";

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

const mockPageCtx = {
  isWandOpen: false,
  openWand: vi.fn(),
  closeWand: vi.fn(),
};

vi.mock("@/lib/page-context", () => ({
  usePageContext: () => mockPageCtx,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render: r }: { render: React.ReactElement }) => r,
  TooltipPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Wand2: () => <span data-testid="wand-icon" />,
}));

import { WandButton } from "./wand-button";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockPathname = "/acme/prod/dashboard";
  mockPageCtx.isWandOpen = false;
  mockPageCtx.openWand = vi.fn();
  mockPageCtx.closeWand = vi.fn();
});

describe("WandButton", () => {
  it("returns null when pathname ends with '/ask'", () => {
    mockPathname = "/acme/prod/ask";
    const { container } = render(<WandButton />);
    expect(container.firstChild).toBeNull();
  });

  it("renders button with aria-label='Open AI agent' when closed", () => {
    mockPageCtx.isWandOpen = false;
    render(<WandButton />);
    const btn = screen.getByRole("button", { name: /open ai agent/i });
    expect(btn).toBeDefined();
  });

  it("button has aria-expanded=false when closed", () => {
    mockPageCtx.isWandOpen = false;
    render(<WandButton />);
    const btn = screen.getByRole("button", { name: /open ai agent/i });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders button with aria-label='Close AI agent' when isWandOpen=true", () => {
    mockPageCtx.isWandOpen = true;
    render(<WandButton />);
    const btn = screen.getByRole("button", { name: /close ai agent/i });
    expect(btn).toBeDefined();
  });

  it("button has aria-expanded=true when isWandOpen=true", () => {
    mockPageCtx.isWandOpen = true;
    render(<WandButton />);
    const btn = screen.getByRole("button", { name: /close ai agent/i });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking when closed calls openWand", () => {
    mockPageCtx.isWandOpen = false;
    render(<WandButton />);
    const btn = screen.getByRole("button", { name: /open ai agent/i });
    fireEvent.click(btn);
    expect(mockPageCtx.openWand).toHaveBeenCalled();
    expect(mockPageCtx.closeWand).not.toHaveBeenCalled();
  });

  it("clicking when open calls closeWand", () => {
    mockPageCtx.isWandOpen = true;
    render(<WandButton />);
    const btn = screen.getByRole("button", { name: /close ai agent/i });
    fireEvent.click(btn);
    expect(mockPageCtx.closeWand).toHaveBeenCalled();
    expect(mockPageCtx.openWand).not.toHaveBeenCalled();
  });
});
