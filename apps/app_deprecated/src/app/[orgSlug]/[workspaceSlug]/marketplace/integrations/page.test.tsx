// @vitest-environment jsdom
/**
 * page.test.tsx — Marketplace → Integrations grid.
 *
 * Regression cover for the "sea of primaries" fix: a catalog of 9+ connectors
 * each rendered a full-width FILLED primary "Connect", so every card competed
 * for the eye. Each card's Connect must now be a secondary (outline) action,
 * leaving the page with at most one filled primary.
 *
 * The page is an async Server Component, so it's awaited and the resolved
 * element handed to render(). Button is stubbed to record the `variant` it
 * receives (asserting intent, not brittle CSS classes) while still forwarding
 * the Link so its data-testid survives.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const { listConnectors } = vi.hoisted(() => ({ listConnectors: vi.fn() }));

vi.mock("@oxagen/ingestion/connectors", () => ({ listConnectors }));
vi.mock("@/lib/workbench/scope", () => ({
  resolveWorkbenchScope: vi.fn(async () => ({
    orgId: "org-1",
    workspaceId: "ws-1",
  })),
}));
vi.mock("@/components/plugins/capability-icon", () => ({
  CapabilityIcon: () => null,
}));
// Stub Button to record the variant while forwarding the `render` Link so the
// integration-connect-<id> testid still lands on the anchor.
vi.mock("@/components/ui/button", () => ({
  Button: ({
    variant = "default",
    render: renderEl,
    children,
  }: {
    variant?: string;
    render?: React.ReactElement;
    children?: React.ReactNode;
  }) =>
    renderEl
      ? React.cloneElement(
          renderEl,
          { "data-variant": variant } as Record<string, unknown>,
          children,
        )
      : React.createElement("button", { "data-variant": variant }, children),
}));

import MarketplaceIntegrationsPage from "./page";

function connector(overrides: Record<string, unknown> = {}) {
  return {
    connectorId: "slack",
    displayName: "Slack",
    description: "Ingest Slack messages.",
    icon: "slack",
    deliveryMethod: "webhook",
    ...overrides,
  };
}

async function renderPage() {
  const el = await MarketplaceIntegrationsPage({
    params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "eng" }),
  });
  render(el);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MarketplaceIntegrationsPage", () => {
  it("renders every card's Connect as a secondary (outline) action, not a filled primary", async () => {
    listConnectors.mockReturnValue([
      connector({ connectorId: "slack", displayName: "Slack" }),
      connector({ connectorId: "linear", displayName: "Linear" }),
      connector({ connectorId: "notion", displayName: "Notion" }),
    ]);

    await renderPage();

    const connects = [
      screen.getByTestId("integration-connect-slack"),
      screen.getByTestId("integration-connect-linear"),
      screen.getByTestId("integration-connect-notion"),
    ];
    expect(connects).toHaveLength(3);
    for (const btn of connects) {
      // Demoted: outline, never the filled "default" primary.
      expect(btn).toHaveAttribute("data-variant", "outline");
    }
  });

  it("filters out the example-saas reference connector", async () => {
    listConnectors.mockReturnValue([
      connector({ connectorId: "slack", displayName: "Slack" }),
      connector({ connectorId: "example-saas", displayName: "Example SaaS" }),
    ]);

    await renderPage();

    expect(screen.getByTestId("integration-connect-slack")).toBeInTheDocument();
    expect(
      screen.queryByTestId("integration-connect-example-saas"),
    ).not.toBeInTheDocument();
  });
});
