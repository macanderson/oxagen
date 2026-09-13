// @vitest-environment jsdom
/**
 * page-tabs-render.test.tsx — JSDOM render tests for the PageTabs component.
 *
 * Mocks next/link and next/navigation (usePathname) so the component
 * can render in JSDOM without the full Next.js runtime.
 */

import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach, vi, beforeEach } from "vitest";

// Must mock Next.js modules before importing the component
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
  usePathname: vi.fn(() => "/org/ws/billing"),
}));

// Mock motion/react to avoid layout-effect issues in JSDOM
vi.mock("motion/react", () => ({
  motion: {
    span: function MotionSpan({
      children,
      layoutId: _,
      transition: __,
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
import { PageTabs } from "./page-tabs";

// Polyfill ResizeObserver (not available in JSDOM)
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(cleanup);

const tabs = [
  { label: "Overview", href: "/org/ws/billing" },
  { label: "Invoices", href: "/org/ws/billing/invoices", badge: 3 },
  { label: "Settings", href: "/org/ws/billing/settings" },
];

describe("PageTabs — render", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/org/ws/billing");
  });

  it("renders a tablist with aria-label", () => {
    const { getByRole } = render(<PageTabs tabs={tabs} />);
    expect(getByRole("tablist")).toBeInTheDocument();
    expect(getByRole("tablist")).toHaveAttribute("aria-label", "Page sections");
  });

  it("renders all tab links", () => {
    const { getAllByRole } = render(<PageTabs tabs={tabs} />);
    expect(getAllByRole("tab")).toHaveLength(3);
  });

  it("active tab has aria-selected=true", () => {
    const { getByRole } = render(<PageTabs tabs={tabs} />);
    const activeTab = getByRole("tab", { name: /Overview/ });
    expect(activeTab).toHaveAttribute("aria-selected", "true");
  });

  it("inactive tabs have aria-selected=false", () => {
    const { getByRole } = render(<PageTabs tabs={tabs} />);
    expect(getByRole("tab", { name: /Invoices/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(getByRole("tab", { name: /Settings/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("tab with badge renders badge span with label", () => {
    const { getByLabelText } = render(<PageTabs tabs={tabs} />);
    expect(getByLabelText("3 items")).toBeInTheDocument();
  });

  it("tab without badge does not render badge span", () => {
    const noLabelTabs = [
      { label: "Overview", href: "/org/ws/billing" },
      { label: "Settings", href: "/org/ws/billing/settings" },
    ];
    const { queryByLabelText } = render(<PageTabs tabs={noLabelTabs} />);
    expect(queryByLabelText(/items/)).toBeNull();
  });

  it("active tab matches longest prefix when on nested path", () => {
    vi.mocked(usePathname).mockReturnValue("/org/ws/billing/invoices");
    const { getByRole } = render(<PageTabs tabs={tabs} />);
    expect(getByRole("tab", { name: /Invoices/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(getByRole("tab", { name: /Overview/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("accepts and applies custom className to root wrapper", () => {
    const { container } = render(
      <PageTabs tabs={tabs} className="custom-tabs" />,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "custom-tabs",
    );
  });
});
