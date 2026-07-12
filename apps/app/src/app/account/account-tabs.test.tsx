// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
/**
 * account-tabs.test.tsx — render tests for the shared /account/* tab strip.
 *
 * Mocks next/link, next/navigation (usePathname), and motion/react so the
 * underlying PageTabs (via TabStrip) can render in JSDOM — copied from
 * page-tabs-render.test.tsx's mocking conventions.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach, vi, beforeEach } from "vitest";

vi.mock("next/link", () => ({
  default: function MockLink({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/account/profile"),
}));

vi.mock("motion/react", () => ({
  motion: {
    span: function MotionSpan({
      children,
      layoutId: _l,
      transition: _t,
      ...props
    }: {
      children?: React.ReactNode;
      layoutId?: string;
      transition?: unknown;
      [key: string]: unknown;
    }) {
      return <span {...props}>{children}</span>;
    },
  },
}));

import * as React from "react";
import { usePathname } from "next/navigation";
import { AccountTabs } from "./account-tabs";

// Polyfill ResizeObserver (not available in JSDOM) — PageTabs observes its
// scroller to toggle the edge-fade affordances.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

describe("AccountTabs", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/account/profile");
  });

  it("renders inside a data-testid wrapper", () => {
    const { getByTestId } = render(<AccountTabs />);
    expect(getByTestId("account-tab-strip")).toBeInTheDocument();
  });

  it("renders all four account tabs with the routes.ts account hrefs", () => {
    const { getByRole } = render(<AccountTabs />);
    expect(getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "href",
      "/account/profile",
    );
    expect(getByRole("tab", { name: "Preferences" })).toHaveAttribute(
      "href",
      "/account/preferences",
    );
    expect(getByRole("tab", { name: "Security" })).toHaveAttribute(
      "href",
      "/account/security",
    );
    expect(getByRole("tab", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/account/privacy",
    );
  });

  it("marks the tab matching the current pathname as active", () => {
    vi.mocked(usePathname).mockReturnValue("/account/security");
    const { getByRole } = render(<AccountTabs />);
    expect(getByRole("tab", { name: "Security" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(getByRole("tab", { name: "Profile" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("does not hide the tab strip on mobile (no hidden classes on the wrapper)", () => {
    const { getByTestId } = render(<AccountTabs />);
    expect(getByTestId("account-tab-strip").className).not.toMatch(/\bhidden\b/);
  });
});
