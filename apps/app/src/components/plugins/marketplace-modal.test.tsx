// @vitest-environment jsdom
/**
 * marketplace-modal.test.tsx — render tests for MarketplaceModal.
 *
 * Covers:
 *   - Closed state: dialog not in DOM
 *   - Open state: renders "Plugin Marketplace" title
 *   - Open state: renders the three tabs (MCP Servers, Integrations, Content Tools)
 *   - Open state: renders search input
 *   - Open state: renders auth filter chips (All, oauth, secret, none)
 *   - Open state: "Select plugins to bulk-install" placeholder shown
 *   - Open state: Cancel button rendered in footer
 *   - Open state: Install selected button is disabled when nothing selected
 *   - Shows server cards when fetch succeeds
 *   - Renders error message when fetch fails
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketplaceModal } from "./marketplace-modal";

afterEach(cleanup);

const installAction = vi.fn().mockResolvedValue({ ok: true, orgListingId: "listing-1" });
const installBulkAction = vi.fn().mockResolvedValue({ ok: true });

const defaultProps = {
  orgSlug: "acme",
  open: false,
  onOpenChange: vi.fn(),
  installAction,
  installBulkAction,
};

// Mock fetch for catalog browse
const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ servers: [], nextOffset: null, total: 0 }),
    text: () => Promise.resolve(""),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MarketplaceModal — closed", () => {
  it("does not render dialog content when closed", () => {
    render(<MarketplaceModal {...defaultProps} />);
    expect(screen.queryByText("Plugin Marketplace")).not.toBeInTheDocument();
  });
});

describe("MarketplaceModal — open", () => {
  it("renders 'Plugin Marketplace' title when open", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText("Plugin Marketplace")).toBeInTheDocument();
  });

  it("renders MCP Servers tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
  });

  it("renders Integrations tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText("Integrations")).toBeInTheDocument();
  });

  it("renders Content Tools tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText("Content Tools")).toBeInTheDocument();
  });

  it("renders search input", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByPlaceholderText("Search…")).toBeInTheDocument();
  });

  it("renders auth filter chips", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByTestId("marketplace-filter-auth-all")).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-filter-auth-oauth")).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-filter-auth-secret")).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-filter-auth-none")).toBeInTheDocument();
  });

  it("renders the 'Select plugins to bulk-install' placeholder", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText(/select plugins to bulk-install/i)).toBeInTheDocument();
  });

  it("Cancel button closes the modal", async () => {
    const onOpenChange = vi.fn();
    render(<MarketplaceModal {...defaultProps} open onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Install selected button is disabled when no items selected", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByTestId("marketplace-bulk-install-btn")).toBeDisabled();
  });
});

describe("MarketplaceModal — server cards", () => {
  it("renders server card when fetch returns data", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "srv-1",
              name: "github",
              title: "GitHub MCP",
              description: "GitHub integration",
              icons: [],
              transportTypes: ["http"],
              authKind: "oauth",
              categories: ["dev-tools"],
              version: "1.0.0",
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-1")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
  });

  it("renders denied badge for blocked servers", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "srv-denied",
              name: "blocked-server",
              title: "Blocked Server",
              description: "Blocked",
              icons: [],
              transportTypes: ["http"],
              authKind: "none",
              categories: [],
              version: "1.0.0",
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open deniedNames={["blocked-server"]} />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-denied-badge-srv-denied")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("renders error message when fetch fails", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      text: () => Promise.resolve("Server error"),
      json: () => Promise.resolve({}),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () => expect(screen.getByText("Server error")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});
