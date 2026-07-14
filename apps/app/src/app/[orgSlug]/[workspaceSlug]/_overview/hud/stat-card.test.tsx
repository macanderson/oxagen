// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { StatCard } from "./stat-card";

afterEach(cleanup);

describe("StatCard", () => {
  it("renders the label and value", () => {
    render(
      <StatCard
        label="Spend · month to date"
        value="$12.50"
        data-testid="stat-card"
      />,
    );

    expect(screen.getByTestId("stat-card")).toBeInTheDocument();
    expect(screen.getByText("Spend · month to date")).toBeInTheDocument();
    expect(screen.getByText("$12.50")).toBeInTheDocument();
  });

  it("renders sub, delta, and visual when provided", () => {
    render(
      <StatCard
        label="Tokens used"
        value="1.2k"
        sub="800 in · 400 out"
        delta={<span data-testid="stub-delta">+10%</span>}
        visual={<span data-testid="stub-visual">viz</span>}
        data-testid="stat-card"
      />,
    );

    expect(screen.getByText("800 in · 400 out")).toBeInTheDocument();
    expect(screen.getByTestId("stub-delta")).toBeInTheDocument();
    expect(screen.getByTestId("stub-visual")).toBeInTheDocument();
  });

  it("renders the card as a link when href is set", () => {
    render(
      <StatCard
        label="Agent runs"
        value="42"
        href="/acme/billing/usage"
        data-testid="stat-card"
      />,
    );

    const card = screen.getByTestId("stat-card");
    expect(card).toBeInTheDocument();
    const link = card.querySelector("a");
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute("href", "/acme/billing/usage");
  });

  it("does not render a link when href is not set", () => {
    render(<StatCard label="Agent runs" value="42" data-testid="stat-card" />);

    const card = screen.getByTestId("stat-card");
    expect(card.querySelector("a")).toBeNull();
  });
});
