// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import * as React from "react";

const mockPathname = vi.fn(() => "/acme");

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname(),
}));

import { OrgOnlyMount } from "./org-only-mount";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockPathname.mockReturnValue("/acme");
});

describe("OrgOnlyMount", () => {
  it("renders children on the org root (/{org})", () => {
    mockPathname.mockReturnValue("/acme");
    render(
      <OrgOnlyMount orgSlug="acme">
        <div data-testid="overlay">overlay</div>
      </OrgOnlyMount>,
    );
    expect(screen.getByTestId("overlay")).toBeDefined();
  });

  it("renders children on reserved org-scope routes (/{org}/settings)", () => {
    mockPathname.mockReturnValue("/acme/settings");
    render(
      <OrgOnlyMount orgSlug="acme">
        <div data-testid="overlay">overlay</div>
      </OrgOnlyMount>,
    );
    expect(screen.getByTestId("overlay")).toBeDefined();
  });

  it("renders children on /{org}/members", () => {
    mockPathname.mockReturnValue("/acme/members");
    render(
      <OrgOnlyMount orgSlug="acme">
        <div data-testid="overlay">overlay</div>
      </OrgOnlyMount>,
    );
    expect(screen.getByTestId("overlay")).toBeDefined();
  });

  it("returns null on workspace paths (/{org}/{ws}/ask) — workspace layout takes over", () => {
    mockPathname.mockReturnValue("/acme/prod/ask");
    render(
      <OrgOnlyMount orgSlug="acme">
        <div data-testid="overlay">overlay</div>
      </OrgOnlyMount>,
    );
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  it("returns null on workspace knowledge path (/{org}/{ws}/knowledge/sources)", () => {
    mockPathname.mockReturnValue("/acme/prod/knowledge/sources");
    render(
      <OrgOnlyMount orgSlug="acme">
        <div data-testid="overlay">overlay</div>
      </OrgOnlyMount>,
    );
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  it("returns null on /{org}/{ws} workspace root", () => {
    mockPathname.mockReturnValue("/acme/prod");
    render(
      <OrgOnlyMount orgSlug="acme">
        <div data-testid="overlay">overlay</div>
      </OrgOnlyMount>,
    );
    expect(screen.queryByTestId("overlay")).toBeNull();
  });

  it("does NOT confuse /{org}/billing/usage (org tab) for a workspace path", () => {
    // 'billing' is a reserved org-scope route, so /{org}/billing/usage is org mode.
    mockPathname.mockReturnValue("/acme/billing/usage");
    render(
      <OrgOnlyMount orgSlug="acme">
        <div data-testid="overlay">overlay</div>
      </OrgOnlyMount>,
    );
    expect(screen.getByTestId("overlay")).toBeDefined();
  });
});
