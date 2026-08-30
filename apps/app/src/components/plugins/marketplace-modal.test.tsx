// @vitest-environment jsdom
/**
 * marketplace-modal.test.tsx — render tests for MarketplaceModal.
 *
 * The modal is the Agent Tools Marketplace. It exposes exactly THREE tabs, in
 * order: Skills (agent_skill), MCP Servers (mcp_server), Capabilities
 * (agent_capability). The default/active tab on open is agent_skill. The
 * Integrations and Knowledge Sources tabs were removed from this modal —
 * integrations now live on the standalone Marketplace → Integrations page — so
 * those tabs must be absent from the DOM.
 *
 * Covers:
 *   - Closed state: dialog not in DOM
 *   - Open state: renders "Agent Tools Marketplace" title
 *   - Open state: renders exactly the three agent-tool tabs (Skills, MCP Servers, Capabilities)
 *   - Open state: Integrations / Knowledge Sources tabs are ABSENT
 *   - Open state: renders search input
 *   - Open state: auth filter chips (All, oauth, secret, none) are hidden on the
 *     default agent_skill tab and appear only after switching to the mcp_server tab
 *   - Open state: auth filter chips hidden on agent_capability / agent_skill tabs
 *   - Open state: "Select plugins to bulk-install" placeholder shown
 *   - Open state: Cancel button rendered in footer
 *   - Open state: Install selected button is disabled when nothing selected
 *   - Shows server cards when fetch succeeds
 *   - Renders a stable error message (never the raw response body) when fetch fails
 *   - Names the access problem specifically on a 403
 *   - fetchServers calls GET (not POST) with URLSearchParams; initial pluginType=agent_skill
 *   - Tab switching changes activeTab, clears selection, and clears server list
 *   - Switching to mcp_server / agent_capability tab sends the matching pluginType
 *   - Auth filter chip click triggers refetch (on mcp_server tab)
 *   - Search input triggers debounced fetchServers
 *   - Selecting a server enables bulk install button and shows selected count
 *   - Bulk install sends srv.name (not srv.id) as catalogServerId — the bulk-install fix
 *   - Bulk install error displays error message
 *   - agent_capability / agent_skill bulk install resolves UUID id → slug name as catalogServerId
 *   - Clicking server card opens detail panel
 *   - Load more button triggers paginated fetch
 *   - Server with icon renders img element
 *   - Server with null title falls back to name
 *   - mcp_server card renders "Installed" badge when installed=true
 *   - agent_capability card renders "Installed" badge when installed=true
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarketplaceModal } from "./marketplace-modal";

// Mock PluginDetailPanel to avoid its own fetch calls.
vi.mock("./plugin-detail-panel", () => ({
  PluginDetailPanel: ({
    serverName,
    onClose,
    onInstalled,
  }: {
    serverName: string;
    onClose: () => void;
    onInstalled: () => void;
    pluginType: string;
    installAction: unknown;
  }) => (
    <div data-testid={`detail-panel-${serverName}`}>
      <button type="button" onClick={onClose} data-testid="detail-panel-close">
        Close
      </button>
      <button
        type="button"
        onClick={onInstalled}
        data-testid="detail-panel-install"
      >
        Install
      </button>
    </div>
  ),
}));

// useToast requires a <Toast.Provider> ancestor at runtime; mock it so the modal
// can be unit-tested in isolation.
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

// useTenant is sourced from TenantContext; mock it so the modal renders without
// a real TenantProvider ancestor in the unit-test tree.
vi.mock("@/lib/tenant/tenant-context", () => ({
  useTenant: () => ({
    orgId: "org-123",
    orgSlug: "acme",
    orgName: "Acme Corp",
    workspaceId: "ws-123",
    workspaceSlug: "acme-ws",
    workspaceName: "Acme Workspace",
  }),
}));

afterEach(cleanup);

const installAction = vi
  .fn()
  .mockResolvedValue({ ok: true, orgListingId: "listing-1" });
const installBulkAction = vi.fn().mockResolvedValue({ ok: true });

const defaultProps = {
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
    expect(
      screen.queryByText("Agent Tools Marketplace"),
    ).not.toBeInTheDocument();
  });
});

describe("MarketplaceModal — open", () => {
  it("renders 'Agent Tools Marketplace' title when open", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText("Agent Tools Marketplace")).toBeInTheDocument();
  });

  it("renders Skills tab (the default active tab)", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText("Skills")).toBeInTheDocument();
    expect(
      screen.getByTestId("marketplace-tab-agent_skill"),
    ).toBeInTheDocument();
  });

  it("renders MCP Servers tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText("MCP Servers")).toBeInTheDocument();
    expect(
      screen.getByTestId("marketplace-tab-mcp_server"),
    ).toBeInTheDocument();
  });

  it("renders Capabilities tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByText("Capabilities")).toBeInTheDocument();
    expect(
      screen.getByTestId("marketplace-tab-agent_capability"),
    ).toBeInTheDocument();
  });

  it("does NOT render the Integrations tab (moved to the Integrations marketplace page)", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.queryByText("Integrations")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("marketplace-tab-integration"),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the Knowledge Sources tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.queryByText("Knowledge Sources")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("marketplace-tab-knowledge_source"),
    ).not.toBeInTheDocument();
  });

  it("does NOT render Content Tools tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.queryByText("Content Tools")).not.toBeInTheDocument();
  });

  it("does NOT render Oxagen Plugins tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.queryByText("Oxagen Plugins")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("marketplace-tab-capability"),
    ).not.toBeInTheDocument();
  });

  it("renders search input", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(screen.getByPlaceholderText("Search…")).toBeInTheDocument();
  });

  it("hides auth filter chips on the default agent_skill tab, shows them after switching to mcp_server", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    // Default tab is agent_skill: auth chips are not applicable and must be hidden.
    expect(
      screen.queryByTestId("marketplace-filter-auth-all"),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("marketplace-tab-mcp_server"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-filter-auth-all"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(
      screen.getByTestId("marketplace-filter-auth-oauth"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("marketplace-filter-auth-secret"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("marketplace-filter-auth-none"),
    ).toBeInTheDocument();
  });

  it("renders the 'Select plugins to bulk-install' placeholder", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(
      screen.getByText(/select plugins to bulk-install/i),
    ).toBeInTheDocument();
  });

  it("Cancel button closes the modal", async () => {
    const onOpenChange = vi.fn();
    render(
      <MarketplaceModal {...defaultProps} open onOpenChange={onOpenChange} />,
    );
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
              pluginType: "mcp_server",
              installed: false,
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-srv-1"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
  });

  it("renders a stable error message — never the raw response body — when fetch fails", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("<html>nginx internal detail</html>"),
      json: () => Promise.resolve({}),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () =>
        expect(
          screen.getByText(/Couldn't load the plugin catalog \(500\)/),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    // The raw body is logged for operators, not painted into the dialog.
    expect(screen.queryByText(/nginx internal detail/)).toBeNull();
    consoleError.mockRestore();
  });

  it("names the access problem specifically on a 403", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve("forbidden"),
      json: () => Promise.resolve({}),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () =>
        expect(
          screen.getByText(/don't have access to the plugin catalog/),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    consoleError.mockRestore();
  });
});

describe("MarketplaceModal — fetch method", () => {
  it("calls GET (not POST) with URLSearchParams including pluginType=agent_skill by default", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });
    const firstCall = mockFetch.mock.calls[0];
    const url = firstCall?.[0] as string;
    expect(url).toMatch(/^\/api\/v1\/plugin\/catalog\/browse\?/);
    expect(url).toContain("pluginType=agent_skill");
    expect(url).not.toMatch(/undefined/);
    // Verify no second argument (no POST body)
    expect(firstCall?.[1]).toBeUndefined();
  });

  it("does NOT include orgId in the browse request URL", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).not.toContain("orgId");
  });

  it("includes workspaceId in the browse request URL", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("workspaceId=ws-123");
  });

  it("includes search param when search is set", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    const input = screen.getByPlaceholderText("Search…");
    await userEvent.type(input, "github");
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls.map((c) => c[0] as string);
        expect(calls.some((url) => url.includes("search=github"))).toBe(true);
      },
      { timeout: 2000 },
    );
  });

  it("includes authKind param when auth filter is set (on mcp_server tab)", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    // Auth chips only exist on the mcp_server tab; switch there first.
    await userEvent.click(screen.getByTestId("marketplace-tab-mcp_server"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-filter-auth-oauth"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

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
  it("switches to MCP Servers tab on click", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    await userEvent.click(screen.getByTestId("marketplace-tab-mcp_server"));
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls.map((c) => c[0] as string);
        expect(calls.some((url) => url.includes("pluginType=mcp_server"))).toBe(
          true,
        );
      },
      { timeout: 3000 },
    );
  });

  it("switches to Capabilities tab on click", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    await userEvent.click(
      screen.getByTestId("marketplace-tab-agent_capability"),
    );
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls.map((c) => c[0] as string);
        expect(
          calls.some((url) => url.includes("pluginType=agent_capability")),
        ).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it("returns to the Skills tab and re-fetches pluginType=agent_skill", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    // Leave the default agent_skill tab, then come back to it.
    await userEvent.click(screen.getByTestId("marketplace-tab-mcp_server"));
    await waitFor(
      () => {
        const calls = mockFetch.mock.calls.map((c) => c[0] as string);
        expect(calls.some((url) => url.includes("pluginType=mcp_server"))).toBe(
          true,
        );
      },
      { timeout: 3000 },
    );

    const callsBefore = mockFetch.mock.calls.length;
    await userEvent.click(screen.getByTestId("marketplace-tab-agent_skill"));
    await waitFor(
      () => {
        const laterCalls = mockFetch.mock.calls
          .slice(callsBefore)
          .map((c) => c[0] as string);
        expect(
          laterCalls.some((url) => url.includes("pluginType=agent_skill")),
        ).toBe(true);
      },
      { timeout: 3000 },
    );
  });
});

describe("MarketplaceModal — auth filter visibility", () => {
  it("auth filter chips are hidden on the default agent_skill tab", () => {
    render(<MarketplaceModal {...defaultProps} open />);
    expect(
      screen.queryByTestId("marketplace-filter-auth-all"),
    ).not.toBeInTheDocument();
  });

  it("auth filter chips are visible after switching to the mcp_server tab", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    await userEvent.click(screen.getByTestId("marketplace-tab-mcp_server"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-filter-auth-all"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("auth filter chips are hidden on agent_capability tab", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    // Show them first (mcp_server), then confirm they disappear on agent_capability.
    await userEvent.click(screen.getByTestId("marketplace-tab-mcp_server"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-filter-auth-all"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(
      screen.getByTestId("marketplace-tab-agent_capability"),
    );
    await waitFor(
      () =>
        expect(
          screen.queryByTestId("marketplace-filter-auth-all"),
        ).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("auth filter chips are hidden on agent_skill tab", async () => {
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    // Show them first (mcp_server), then confirm they disappear back on agent_skill.
    await userEvent.click(screen.getByTestId("marketplace-tab-mcp_server"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-filter-auth-all"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-tab-agent_skill"));
    await waitFor(
      () =>
        expect(
          screen.queryByTestId("marketplace-filter-auth-all"),
        ).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

describe("MarketplaceModal — selection and bulk install", () => {
  // Fixture: id is a compound catalog id (registryId:serverName:version),
  // name is the bare server name that the install handler expects.
  // id !== name to exercise the bulk-install fix.
  const serverResponse = {
    ok: true,
    json: () =>
      Promise.resolve({
        servers: [
          {
            id: "reg-uuid:tool-a:1.0",
            name: "tool-a",
            title: "Tool A",
            description: "desc",
            icons: [],
            transportTypes: ["http"],
            authKind: "none",
            categories: [],
            version: "1.0",
            pluginType: "mcp_server",
            installed: false,
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
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-reg-uuid:tool-a:1.0"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(
      screen.getByTestId("marketplace-select-reg-uuid:tool-a:1.0"),
    );
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(
      screen.getByTestId("marketplace-bulk-install-btn"),
    ).not.toBeDisabled();
  });

  it("deselecting a server removes it from selection", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-reg-uuid:tool-a:1.0"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    const checkbox = screen.getByTestId(
      "marketplace-select-reg-uuid:tool-a:1.0",
    );
    await userEvent.click(checkbox); // select
    await userEvent.click(checkbox); // deselect
    expect(
      screen.getByText(/select plugins to bulk-install/i),
    ).toBeInTheDocument();
  });

  it("bulk install resolves compound id to srv.name — sends name not id as catalogServerId", async () => {
    // This is the bulk-install fix: id="reg-uuid:tool-a:1.0", name="tool-a".
    // installBulkAction must receive catalogServerId="tool-a", NOT "reg-uuid:tool-a:1.0".
    // The fixture is an mcp_server entry, so switch to the mcp_server tab first so
    // the bulk-install call carries pluginType="mcp_server".
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
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    await userEvent.click(screen.getByTestId("marketplace-tab-mcp_server"));
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-reg-uuid:tool-a:1.0"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(
      screen.getByTestId("marketplace-select-reg-uuid:tool-a:1.0"),
    );
    await userEvent.click(screen.getByTestId("marketplace-bulk-install-btn"));

    await waitFor(() =>
      expect(bulkAction).toHaveBeenCalledWith({
        orgSlug: "acme",
        workspaceId: "ws-123",
        // catalogServerId must be the name "tool-a", NOT the compound id
        items: [{ catalogServerId: "tool-a", pluginType: "mcp_server" }],
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("bulk install error displays error message", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    const bulkAction = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "Install failed" });
    render(
      <MarketplaceModal
        {...defaultProps}
        open
        installBulkAction={bulkAction}
      />,
    );
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-reg-uuid:tool-a:1.0"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(
      screen.getByTestId("marketplace-select-reg-uuid:tool-a:1.0"),
    );
    await userEvent.click(screen.getByTestId("marketplace-bulk-install-btn"));

    await waitFor(
      () => expect(screen.getByText("Install failed")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("agent_capability bulk install resolves UUID id to slug name as catalogServerId", async () => {
    // Fixture: id is a UUID (the catalog row PK for capability/skill types);
    // name is the slug the install handler expects.
    // id !== name — exercises the fix for non-MCP plugin types.
    const capResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "cap-123",
              name: "oxagen/media-svg",
              title: "SVG Generation",
              description: "desc",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: ["media"],
              version: "1.0.0",
              pluginType: "agent_capability",
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
      <MarketplaceModal
        {...defaultProps}
        open
        installBulkAction={bulkAction}
      />,
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    await userEvent.click(
      screen.getByTestId("marketplace-tab-agent_capability"),
    );
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-cap-123"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-select-cap-123"));
    await userEvent.click(screen.getByTestId("marketplace-bulk-install-btn"));

    await waitFor(() =>
      expect(bulkAction).toHaveBeenCalledWith(
        expect.objectContaining({
          items: expect.arrayContaining([
            // catalogServerId must be the name/slug "oxagen/media-svg", NOT the UUID "cap-123"
            expect.objectContaining({
              pluginType: "agent_capability",
              catalogServerId: "oxagen/media-svg",
            }),
          ]),
        }),
      ),
    );
  });

  it("agent_skill bulk install resolves UUID id to slug name as catalogServerId", async () => {
    // Fixture: id is a UUID (skill row pk), name is the skill slug.
    const skillResponse = {
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
              name: "browser-use",
              title: "Browser Use",
              description: "Autonomous browser agent skill",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: ["automation"],
              version: "1.0.0",
              pluginType: "agent_skill",
              installed: false,
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    };
    mockFetch.mockResolvedValue(skillResponse);

    const bulkAction = vi.fn().mockResolvedValue({ ok: true });
    render(
      <MarketplaceModal
        {...defaultProps}
        open
        installBulkAction={bulkAction}
      />,
    );
    // agent_skill is the default tab, so the initial fetch already returns the
    // skill fixture — no tab switch needed before selecting.
    await waitFor(
      () =>
        expect(
          screen.getByTestId(
            "marketplace-server-card-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
          ),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(
      screen.getByTestId(
        "marketplace-select-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      ),
    );
    await userEvent.click(screen.getByTestId("marketplace-bulk-install-btn"));

    await waitFor(() =>
      expect(bulkAction).toHaveBeenCalledWith(
        expect.objectContaining({
          items: expect.arrayContaining([
            // catalogServerId must be the slug "browser-use", NOT the UUID
            expect.objectContaining({
              pluginType: "agent_skill",
              catalogServerId: "browser-use",
            }),
          ]),
        }),
      ),
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
            pluginType: "mcp_server",
            installed: false,
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
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-srv-b"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-server-card-srv-b"));
    await waitFor(
      // Detail panel is keyed on serverName ("tool-b")
      () =>
        expect(screen.getByTestId("detail-panel-tool-b")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("closing the detail panel hides it", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-srv-b"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-server-card-srv-b"));
    await waitFor(() =>
      expect(screen.getByTestId("detail-panel-tool-b")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId("detail-panel-close"));
    await waitFor(
      () =>
        expect(
          screen.queryByTestId("detail-panel-tool-b"),
        ).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("onInstalled callback closes modal", async () => {
    mockFetch.mockResolvedValue(serverResponse);
    const onOpenChange = vi.fn();
    render(
      <MarketplaceModal {...defaultProps} open onOpenChange={onOpenChange} />,
    );
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-srv-b"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );

    await userEvent.click(screen.getByTestId("marketplace-server-card-srv-b"));
    await waitFor(() =>
      expect(screen.getByTestId("detail-panel-tool-b")).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId("detail-panel-install"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
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
              pluginType: "mcp_server",
              installed: false,
            },
          ],
          nextOffset: 30,
          total: 60,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () =>
        expect(screen.getByTestId("marketplace-load-more")).toBeInTheDocument(),
      { timeout: 3000 },
    );

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ servers: [], nextOffset: null, total: 60 }),
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
              pluginType: "mcp_server",
              installed: false,
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });
    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-server-card-srv-icon"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(
      document.querySelector("img[src='https://example.com/icon.png']"),
    ).not.toBeNull();
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
              pluginType: "mcp_server",
              installed: false,
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

  it("renders 'Installed' badge for mcp_server entries when installed=true", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "srv-installed-mcp",
              name: "installed-mcp",
              title: "Installed MCP",
              description: "desc",
              icons: [],
              transportTypes: ["http"],
              authKind: "none",
              categories: [],
              version: "1.0",
              pluginType: "mcp_server",
              installed: true,
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-installed-badge-srv-installed-mcp"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(
      screen.getByTestId("marketplace-installed-badge-srv-installed-mcp"),
    ).toHaveTextContent("Installed");
  });

  it("renders 'Installed' badge for agent_capability entries when installed=true", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          servers: [
            {
              id: "cap-installed",
              name: "oxagen/documents",
              title: "Documents",
              description: "Generate documents",
              icons: [],
              transportTypes: [],
              authKind: "none",
              categories: ["documents"],
              version: "1.0.0",
              pluginType: "agent_capability",
              installed: true,
            },
          ],
          nextOffset: null,
          total: 1,
        }),
      text: () => Promise.resolve(""),
    });

    render(<MarketplaceModal {...defaultProps} open />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });

    await userEvent.click(
      screen.getByTestId("marketplace-tab-agent_capability"),
    );
    await waitFor(
      () =>
        expect(
          screen.getByTestId("marketplace-installed-badge-cap-installed"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(
      screen.getByTestId("marketplace-installed-badge-cap-installed"),
    ).toHaveTextContent("Installed");
  });
});
