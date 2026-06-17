// @vitest-environment jsdom
/**
 * marketing-hero.test.tsx — render coverage for the shared landing hero
 * (logo lockup, headline, and the two CTA buttons).
 */
import { render, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { MarketingHeroPage } from "./marketing-hero";

afterEach(cleanup);

describe("MarketingHeroPage", () => {
  it("renders the headline and both CTAs", () => {
    const { getAllByText, getByRole } = render(<MarketingHeroPage />);
    expect(getAllByText("Secure context for AI agents").length).toBeGreaterThan(0);
    expect(getByRole("button", { name: "Get started" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Read the docs" })).toBeInTheDocument();
  });

  it("renders the Oxagen wordmark lockup", () => {
    const { getAllByText } = render(<MarketingHeroPage />);
    expect(getAllByText("Oxagen").length).toBeGreaterThan(0);
  });
});
