// @vitest-environment jsdom
/**
 * marketplace-modal.test.tsx — render tests for MarketplaceModal.
 *
 * Covers:
 *   - Closed state: dialog not in DOM
 *   - Open state: renders "Plugin Marketplace" title
 *   - Open state: renders the four tabs (MCP Servers, Integrations, Content Tools, Oxagen Plugins)
 *   - Open state: renders search input
 *   - Open state: renders auth filter chips (All, oauth, secret, none)
 *   - Open state: auth filter chips hidden on capability tab
 *   - Open state: "Select plugins to bulk-install" placeholder shown
 *   - Open state: Cancel button rendered in footer
 *   - Open state: Install selected button is disabled when nothing selected
 *   - Shows server cards when fetch succeeds
 *   - Renders error message when fetch fails
 *   - fetchServers calls GET (not POST) with URLSearchParams
 *   - Tab switching changes activeTab and clears selection
 *   - Switching to capability tab sends pluginType=capability
 *   - Auth filter chip click triggers refetch
 *   - Search input triggers debounced fetchServers
 *   - Selecting a server enables bulk install button and shows selected count
 *   - Bulk install success calls installBulkAction and closes modal
 *   - Bulk install error displays error message
 *   - Capability bulk install sends pluginId (not catalogServerId)
 *   - Clicking server card (not denied) opens detail panel
 *   - Load more button triggers paginated fetch
 *   - Server with icon renders img element
 *   - Server with null title falls back to name
 *   - Capability card renders "Free" tier badge
 *   - Capability card renders "Premium" tier badge
 *   - Capability card renders "Installed" badge when installed=true
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketplaceModal } from "./marketplace-modal";

// Mock PluginDetailPanel to avoid its own fetch calls.
vi.mock("./plugin-detail-panel", () => ({
  PluginDetailPanel: ({
    catalogId,
    onClose,
    onInstalled,
  }: {
    catalogId: string;
    onClose: () => void;
    onInstalled: () => void;
    orgSlug: string;
    pluginType: string;
    isDenied: boolean;
    installAction: unknown;
  }) => (
    <div data-testid={`detail-panel-${catalogId}`}>
      <button type="button" onClick={onClose} data-testid="detail-panel-close">
        Close
      </button>
      <button type="button" onClick={onInstalled} data-testid="detail-panel-install">
        Install
      </button>
    </div>
  ),
}));

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
  vi.clearAllTimers();
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

  it("renders Oxagen Plugins tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText("Oxagen Plugins")).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-tab-capability")).toBeInTheDocument();
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

describe("MarketplaceModal — fetch method", () => {
  it("calls GET (not POST) with URLSearchParams including pluginType", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });
    const firstCall = mockFetch.mock.calls[0];
    const url = firstCall?.[0] as string;
    expect(url).toMatch(/^\/api\/v1\/plugin\/catalog\/browse\?/);
    expect(url).toContain("pluginType=mcp_server");
    expect(url).not.toMatch(/undefined/);
    // Verify no second argument (no POST body)
    expect(firstCall?.[1]).toBeUndefined();
  });

  it("includes search param when search is set", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    const input = screen.getByPlaceholderText("Search…");
    await userEvent.type(input, "github");
    // The debounce is 300ms; waitFor polls up to 2s.
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls.map((c) => c[0] as string);
        expect(calls.some((url) => url.includes("search=github"))).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it("includes authKind param when auth filter is set", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    await userEvent.click(screen.getByTestId("marketplace-filter-auth-oauth"));
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls.map((c) => c[0] as string);
        expect(calls.some((url) => url.includes("authKind=oauth"))).toBe(true);
      },
      { timeout: 3000 },
    );
  });
});

describe("MarketplaceModal — tab switching", () => {
  it("switches to Integrations tab on click", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    await userEvent.click(screen.getByTestId("marketplace-tab-integration"));
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls.map((c) => c[0] as string);
        expect(calls.some((url) => url.includes("pluginType=integration"))).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it("switches to Content Tools tab on click", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    await userEvent.click(screen.getByTestId("marketplace-tab-content_tool"));
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls.map((c) => c[0] as string);
        expect(calls.some((url) => url.includes("pluginType=content_tool"))).toBe(true);
      },
      { timeout: 3000 },
    );
  });
});

describe("MarketplaceModal — selection and bulk install", () => {
  const serverResponse = {
    ok: true,
    json: () =>
      Promise.resolve({
        servers: [
          {
            id: "srv-a",
            name: "tool-a",
            title: "Tool A",
            description: "desc",
            icons: [],
            transportTypes: ["http"],
            authKind: "none",
            categories: [],
            version: "1.0",
          },
        ],
        nextOffset: null,
        total: 1,
      }),
    text: () => Promise.resolve(""),
  };

  it("selecting a server enables bulk install and shows count", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-a")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-select-srv-a"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-bulk-install-btn")).not.toBeDisabled();
  });

  it("deselecting a server removes it from selection", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-a")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    const checkbox = screen.getByTestId("marketplace-select-srv-a");
    await userEvent.click(checkbox); // select
    await userEvent.click(checkbox); // deselect
    expect(screen.getByText(/select plugins to bulk-install/i)).toBeInTheDocument();
  });

  it("bulk install success calls installBulkAction and closes modal", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    const onOpenChange = vi.fn();
    const bulkAction = vi.fn().mockResolvedValue({ ok: true });
    render(
      <MarketplaceModal
        {...defaultProps}
        open
        onOpenChange={onOpenChange}
        installBulkAction={bulkAction}
      />,
    );
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-a")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-select-srv-a"));
    await userEvent.click(screen.getByTestId("marketplace-bulk-install-btn"));

    await waitFor(() => expect(bulkAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      items: [{ catalogServerId: "srv-a", pluginType: "mcp_server" }],
    }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("bulk install error displays error message", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    const bulkAction = vi.fn().mockResolvedValue({ ok: false, error: "Install failed" });
    render(
      <MarketplaceModal {...defaultProps} open installBulkAction={bulkAction} />,
    );
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-a")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-select-srv-a"));
    await userEvent.click(screen.getByTestId("marketplace-bulk-install-btn"));

    await waitFor(
      () => expect(screen.getByText("Install failed")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

describe("MarketplaceModal — detail panel", () => {
  const serverResponse = {
    ok: true,
    json: () =>
      Promise.resolve({
        servers: [
          {
            id: "srv-b",
            name: "tool-b",
            title: "Tool B",
            description: "desc b",
            icons: [],
            transportTypes: ["http"],
            authKind: "oauth",
            categories: [],
            version: "1.0",
          },
        ],
        nextOffset: null,
        total: 1,
      }),
    text: () => Promise.resolve(""),
  };

  it("clicking a server card opens the detail panel", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-b")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-server-card-srv-b"));
    await waitFor(
      () => expect(screen.getByTestId("detail-panel-srv-b")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("closing the detail panel hides it", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-b")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-server-card-srv-b"));
    await waitFor(() => expect(screen.getByTestId("detail-panel-srv-b")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("detail-panel-close"));
    await waitFor(
      () => expect(screen.queryByTestId("detail-panel-srv-b")).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("onInstalled callback closes modal", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    const onOpenChange = vi.fn();
    render(<MarketplaceModal {...defaultProps} open onOpenChange={onOpenChange} />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-b")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-server-card-srv-b"));
    await waitFor(() => expect(screen.getByTestId("detail-panel-srv-b")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("detail-panel-install"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clicking a denied server card does NOT open detail panel", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "srv-denied2",
              name: "blocked",
              title: "Blocked",
              description: "desc",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: [],
              version: "1.0",
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });
    render(<MarketplaceModal {...defaultProps} open deniedNames={["blocked"]} />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-denied2")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-server-card-srv-denied2"));
    expect(screen.queryByTestId("detail-panel-srv-denied2")).not.toBeInTheDocument();
  });
});

describe("MarketplaceModal — load more", () => {
  it("shows Load more button when nextOffset is non-null and calls paginated fetch", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "srv-p1",
              name: "page1",
              title: "Page 1",
              description: "desc",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: [],
              version: "1.0",
            },
          ],
          nextOffset: 30,
          total: 60,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-load-more")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ servers: [], nextOffset: null, total: 60 }),
      text: () => Promise.resolve(""),
    });

    await userEvent.click(screen.getByTestId("marketplace-load-more"));
    await waitFor(
      () => {
        const lastUrl = mockFetch.mock.calls.at(-1)?.[0] as string;
        expect(lastUrl).toContain("offset=30");
      },
      { timeout: 3000 },
    );
  });
});

describe("MarketplaceModal — server card variants", () => {
  it("renders img when server has icon", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "srv-icon",
              name: "with-icon",
              title: "With Icon",
              description: "desc",
              icons: [{ src: "https://example.com/icon.png" }],
              transportTypes: [],
              authKind: "none",
              categories: [],
              version: "1.0",
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () => expect(screen.getByTestId("marketplace-server-card-srv-icon")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(document.querySelector("img[src='https://example.com/icon.png']")).not.toBeNull();
  });

  it("falls back to server name when title is null", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "srv-no-title",
              name: "raw-name",
              title: null,
              description: "desc",
              icons: [],
              transportTypes: [],
              authKind: "secret",
              categories: [],
              version: "1.0",
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () => expect(screen.getByText("raw-name")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("denied card with title uses title in aria-label", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "srv-denied-titled",
              name: "blocked-named",
              title: "Blocked Titled",
              description: "desc",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: [],
              version: "1.0",
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });
    render(<MarketplaceModal {...defaultProps} open deniedNames={["blocked-named"]} />);
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", {
            name: "Blocked Titled — blocked by your organization's admins",
          }),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

// ── Capability tab ─────────────────────────────────────────────────────────────

describe("MarketplaceModal — capability tab", () => {
  it("switching to Oxagen Plugins tab sends pluginType=capability", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    await userEvent.click(screen.getByTestId("marketplace-tab-capability"));
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls.map((c) => c[0] as string);
        expect(calls.some((url) => url.includes("pluginType=capability"))).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it("auth filter chips are hidden on capability tab", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    // Auth chips visible on default mcp_server tab.
    expect(screen.getByTestId("marketplace-filter-auth-all")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("marketplace-tab-capability"));
    // After switching to capability, auth filter chips are removed from DOM.
    await waitFor(
      () => expect(screen.queryByTestId("marketplace-filter-auth-all")).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("renders 'Free' tier badge for a free capability entry", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "oxagen/media-svg",
              name: "oxagen/media-svg",
              title: "SVG Generation",
              description: "Generate SVG images",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: ["media"],
              version: "1.0.0",
              pluginType: "capability",
              tier: "free",
              installed: false,
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    await userEvent.click(screen.getByTestId("marketplace-tab-capability"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-tier-badge-oxagen/media-svg"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(
      screen.getByTestId("marketplace-tier-badge-oxagen/media-svg"),
    ).toHaveTextContent("Free");
  });

  it("renders 'Premium' tier badge for a premium capability entry", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "oxagen/media-video",
              name: "oxagen/media-video",
              title: "Video Generation",
              description: "Generate videos",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: ["media"],
              version: "1.0.0",
              pluginType: "capability",
              tier: "premium",
              installed: false,
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    await userEvent.click(screen.getByTestId("marketplace-tab-capability"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-tier-badge-oxagen/media-video"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(
      screen.getByTestId("marketplace-tier-badge-oxagen/media-video"),
    ).toHaveTextContent("Premium");
  });

  it("renders 'Installed' badge when installed=true", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "oxagen/documents",
              name: "oxagen/documents",
              title: "Documents",
              description: "Generate documents",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: ["documents"],
              version: "1.0.0",
              pluginType: "capability",
              tier: "free",
              installed: true,
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    await userEvent.click(screen.getByTestId("marketplace-tab-capability"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-installed-badge-oxagen/documents"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("capability bulk install sends pluginId instead of catalogServerId", async () => {
    const capResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "oxagen/media-svg",
              name: "oxagen/media-svg",
              title: "SVG Generation",
              description: "desc",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: ["media"],
              version: "1.0.0",
              pluginType: "capability",
              tier: "free",
              installed: false,
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    };
    mockFetch.mockResolvedValue(capResponse);

    const bulkAction = vi.fn().mockResolvedValue({ ok: true });
    render(
      <MarketplaceModal {...defaultProps} open installBulkAction={bulkAction} />,
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), { timeout: 3000 });

    // Switch to capability tab
    await userEvent.click(screen.getByTestId("marketplace-tab-capability"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-oxagen/media-svg"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    // Select the plugin
    await userEvent.click(screen.getByTestId("marketplace-select-oxagen/media-svg"));
    // Click bulk install
    await userEvent.click(screen.getByTestId("marketplace-bulk-install-btn"));

    await waitFor(() =>
      expect(bulkAction).toHaveBeenCalledWith(
        expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ pluginType: "capability", pluginId: "oxagen/media-svg" }),
          ]),
        }),
      ),
    );
    // catalogServerId should NOT be in the capability item
    const callArg = bulkAction.mock.calls[0]?.[0] as { items: Array<{ catalogServerId?: string }> };
    expect(callArg?.items[0]?.catalogServerId).toBeUndefined();
  });
});
