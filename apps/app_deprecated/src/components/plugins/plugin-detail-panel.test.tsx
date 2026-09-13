// @vitest-environment jsdom
/**
 * plugin-detail-panel.test.tsx — render tests for PluginDetailPanel.
 *
 * Covers:
 *   - Shows loading skeleton initially
 *   - Fetches using name+version (not catalogId)
 *   - Shows plugin title after fetch resolves
 *   - Shows plugin description
 *   - Shows website link when websiteUrl is set
 *   - Close button calls onClose
 *   - Badges for transport types and auth kind (mcp_server)
 *   - Categories rendered for agent_capability type
 *   - Install button calls installAction
 *   - No-README fallback message
 *   - Fetch error shows error element
 *   - Already installed state shows disabled button
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PluginDetailPanel } from "./plugin-detail-panel";

// useToast requires a <Toast.Provider> ancestor at runtime; mock it so the
// detail panel can be unit-tested in isolation.
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

// useTenant is sourced from TenantContext; mock it so the panel renders without
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

const mockDetail = {
  name: "github",
  title: "GitHub MCP",
  description: "Connect to GitHub repos",
  version: "1.2.3",
  websiteUrl: "https://github.com/mcp",
  icons: [],
  packages: [],
  remotes: [],
  transportTypes: ["http", "sse"],
  authKind: "oauth",
  categories: ["dev-tools", "automation"],
  readmeHtml: null,
  status: "active",
};

const defaultProps = {
  serverName: "github",
  pluginType: "mcp_server" as const,
  installAction: vi
    .fn()
    .mockResolvedValue({ ok: true, orgListingId: "listing-1" }),
  onInstalled: vi.fn(),
  onClose: vi.fn(),
};

const mockFetch = vi.fn();

// The component's fetch is async; add a small delay so loading state is visible first.
// Mirrors a real OK Response: the panel now checks `r.ok`/`r.status` before
// trusting the body, so the mock must carry them.
function fetchAfterTimer(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      new Promise<unknown>((resolve) => setTimeout(() => resolve(data), 50)),
  });
}

/** Mock a non-OK Response carrying an `{ error }` body (e.g. catalog.get 404/500). */
function fetchError(status: number, body: unknown) {
  return Promise.resolve({
    ok: false,
    status,
    json: () =>
      new Promise<unknown>((resolve) => setTimeout(() => resolve(body), 50)),
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockImplementation(() => fetchAfterTimer(mockDetail));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("PluginDetailPanel — loading state", () => {
  it("shows loading skeleton initially", () => {
    render(<PluginDetailPanel {...defaultProps} />);
    expect(screen.getByTestId("plugin-detail-loading")).toBeInTheDocument();
  });
});

describe("PluginDetailPanel — fetch URL", () => {
  it("fetches using name+version+workspaceId query params (not catalogId)", async () => {
    render(
      <PluginDetailPanel {...defaultProps} serverName="@acme/my-server" />,
    );
    await waitFor(() => expect(mockFetch).toHaveBeenCalled(), {
      timeout: 3000,
    });
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("name=%40acme%2Fmy-server");
    expect(url).toContain("version=latest");
    expect(url).toContain("workspaceId=ws-123");
    expect(url).not.toContain("catalogId");
  });
});

describe("PluginDetailPanel — loaded state", () => {
  it("renders the plugin title after fetch", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () =>
        expect(screen.getByTestId("plugin-detail-title")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
  });

  it("renders the plugin description", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () =>
        expect(screen.getByText("Connect to GitHub repos")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("renders the website link when websiteUrl is set", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () =>
        expect(screen.getByTestId("plugin-detail-website")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("shows 'No README available.' when readmeHtml is null", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () =>
        expect(
          screen.getByTestId("plugin-detail-no-readme"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("renders transport type badges for mcp_server type", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () =>
        expect(screen.getByTestId("plugin-detail-badges")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("sse")).toBeInTheDocument();
  });

  it("renders category badges for mcp_server type", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () => expect(screen.getByText("dev-tools")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("renders category badges for agent_capability type (no transport/auth)", async () => {
    const agentDetail = {
      name: "oxagen/media-svg",
      title: "SVG Generation",
      description: "Generate SVG images",
      version: "1.0.0",
      websiteUrl: null,
      icons: [],
      packages: [],
      remotes: [],
      transportTypes: [],
      authKind: "none",
      categories: ["media", "generation"],
      readmeHtml: null,
      status: "active",
      installed: false,
    };
    mockFetch.mockImplementation(() => fetchAfterTimer(agentDetail));

    render(
      <PluginDetailPanel
        {...defaultProps}
        serverName="oxagen/media-svg"
        pluginType="agent_capability"
      />,
    );
    await waitFor(() => expect(screen.getByText("media")).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText("generation")).toBeInTheDocument();
    // No auth badge for agent types
    expect(screen.queryByText("oauth")).not.toBeInTheDocument();
    expect(screen.queryByText("none")).not.toBeInTheDocument();
  });

  it("does not render README section for agent_capability type", async () => {
    const agentDetail = {
      name: "oxagen/media-svg",
      title: "SVG Generation",
      description: "Generate SVG images",
      version: "1.0.0",
      websiteUrl: null,
      icons: [],
      packages: [],
      remotes: [],
      transportTypes: [],
      authKind: "none",
      categories: ["media"],
      readmeHtml: "<p>Some readme</p>",
      status: "active",
    };
    mockFetch.mockImplementation(() => fetchAfterTimer(agentDetail));

    render(
      <PluginDetailPanel
        {...defaultProps}
        serverName="oxagen/media-svg"
        pluginType="agent_capability"
      />,
    );
    await waitFor(
      () =>
        expect(screen.getByTestId("plugin-detail-panel")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    // README section intentionally suppressed for agent types
    expect(
      screen.queryByTestId("plugin-detail-readme"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("plugin-detail-no-readme"),
    ).not.toBeInTheDocument();
  });
});

describe("PluginDetailPanel — actions", () => {
  it("Close button calls onClose", async () => {
    const onClose = vi.fn();
    render(<PluginDetailPanel {...defaultProps} onClose={onClose} />);
    await waitFor(
      () =>
        expect(screen.getByTestId("plugin-detail-close")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    await userEvent.click(screen.getByTestId("plugin-detail-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Install button triggers installAction and calls onInstalled", async () => {
    const installAction = vi
      .fn()
      .mockResolvedValue({ ok: true, orgListingId: "listing-1" });
    const onInstalled = vi.fn();
    render(
      <PluginDetailPanel
        {...defaultProps}
        installAction={installAction}
        onInstalled={onInstalled}
      />,
    );
    await waitFor(
      () =>
        expect(
          screen.getByTestId("plugin-detail-install-btn"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    await userEvent.click(screen.getByTestId("plugin-detail-install-btn"));
    await waitFor(() => expect(installAction).toHaveBeenCalled());
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
  });

  it("shows 'Already installed' disabled button when installed=true", async () => {
    const installedDetail = { ...mockDetail, installed: true };
    mockFetch.mockImplementation(() => fetchAfterTimer(installedDetail));

    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () =>
        expect(
          screen.getByTestId("plugin-detail-install-btn"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    const btn = screen.getByTestId("plugin-detail-install-btn");
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/already installed/i);
  });

  it("shows install button text as 'Install to workspace'", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () =>
        expect(
          screen.getByTestId("plugin-detail-install-btn"),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByTestId("plugin-detail-install-btn")).toHaveTextContent(
      "Install to workspace",
    );
  });
});

describe("PluginDetailPanel — fetch error", () => {
  it("shows error message when fetch fails", async () => {
    mockFetch.mockImplementation(() =>
      Promise.reject(new Error("Network error")),
    );
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () =>
        expect(screen.getByTestId("plugin-detail-error")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  // Regression: a non-OK response (e.g. catalog.get 500/404) returns `{ error }`,
  // NOT a CatalogDetail. The panel used to treat that body as detail and crash on
  // `detail.icons[0]`, taking the whole marketplace down. It must surface the
  // error message and render the error element instead.
  it("shows the server error (not a crash) on a 500 response", async () => {
    mockFetch.mockImplementation(() =>
      fetchError(500, { error: "no enabled registries for this workspace" }),
    );
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () =>
        expect(screen.getByTestId("plugin-detail-error")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByTestId("plugin-detail-error")).toHaveTextContent(
      /no enabled registries/i,
    );
  });

  it("does not crash and shows an error on a 404 with an error body", async () => {
    mockFetch.mockImplementation(() =>
      fetchError(404, {
        error: "catalog server not found: oxagen/media-image@latest",
      }),
    );
    render(
      <PluginDetailPanel
        {...defaultProps}
        serverName="oxagen/media-image"
        pluginType="agent_capability"
      />,
    );
    await waitFor(
      () =>
        expect(screen.getByTestId("plugin-detail-error")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByTestId("plugin-detail-error")).toHaveTextContent(
      /not found/i,
    );
  });
});
