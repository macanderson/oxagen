// @vitest-environment jsdom
/**
 * plugin-detail-panel.test.tsx — render tests for PluginDetailPanel.
 *
 * Covers:
 *   - Shows loading skeleton initially
 *   - Shows plugin title after fetch resolves
 *   - Shows plugin description
 *   - Shows website link when websiteUrl is set
 *   - Close button calls onClose
 *   - Badges for transport types and auth kind
 *   - Install button calls installAction
 *   - Denied state shows blocked message instead of install button
 *   - No-README fallback message
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PluginDetailPanel } from "./plugin-detail-panel";

afterEach(cleanup);

const mockDetail = {
  id: "srv-1",
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
  catalogId: "srv-1",
  orgSlug: "acme",
  pluginType: "mcp_server" as const,
  isDenied: false,
  installAction: vi.fn().mockResolvedValue({ ok: true, orgListingId: "listing-1" }),
  onInstalled: vi.fn(),
  onClose: vi.fn(),
};

const mockFetch = vi.fn();

// The component uses setTimeout(0) inside useEffect to defer state resets.
// The fetch mock uses a 50ms delay so the deferred setTimeout(0) fires first
// and the component goes loading=true before the data arrives.
function fetchAfterTimer(data: unknown) {
  return Promise.resolve({
    json: () => new Promise<unknown>((resolve) => setTimeout(() => resolve(data), 50)),
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

describe("PluginDetailPanel — loaded state", () => {
  it("renders the plugin title after fetch", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () => expect(screen.getByTestId("plugin-detail-title")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
  });

  it("renders the plugin description", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () => expect(screen.getByText("Connect to GitHub repos")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("renders the website link when websiteUrl is set", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () => expect(screen.getByTestId("plugin-detail-website")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("shows 'No README available.' when readmeHtml is null", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () => expect(screen.getByTestId("plugin-detail-no-readme")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it("renders transport type badges", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () => expect(screen.getByTestId("plugin-detail-badges")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("sse")).toBeInTheDocument();
  });

  it("renders category badges", async () => {
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () => expect(screen.getByText("dev-tools")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

describe("PluginDetailPanel — actions", () => {
  it("Close button calls onClose", async () => {
    const onClose = vi.fn();
    render(<PluginDetailPanel {...defaultProps} onClose={onClose} />);
    await waitFor(
      () => expect(screen.getByTestId("plugin-detail-close")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    await userEvent.click(screen.getByTestId("plugin-detail-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Install button triggers installAction", async () => {
    const installAction = vi.fn().mockResolvedValue({ ok: true, orgListingId: "listing-1" });
    const onInstalled = vi.fn();
    render(<PluginDetailPanel {...defaultProps} installAction={installAction} onInstalled={onInstalled} />);
    await waitFor(
      () => expect(screen.getByTestId("plugin-detail-install-btn")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    await userEvent.click(screen.getByTestId("plugin-detail-install-btn"));
    await waitFor(() => expect(installAction).toHaveBeenCalled());
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
  });
});

describe("PluginDetailPanel — denied state", () => {
  it("shows blocked message when isDenied=true", async () => {
    render(<PluginDetailPanel {...defaultProps} isDenied />);
    await waitFor(
      () => expect(screen.getByTestId("plugin-detail-denied")).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.getByText(/blocked by your organization's admins/i)).toBeInTheDocument();
  });

  it("does not show install button when isDenied=true", async () => {
    render(<PluginDetailPanel {...defaultProps} isDenied />);
    await waitFor(
      () => expect(screen.queryByTestId("plugin-detail-install-btn")).not.toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

describe("PluginDetailPanel — fetch error", () => {
  it("shows error message when fetch fails", async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error("Network error")));
    render(<PluginDetailPanel {...defaultProps} />);
    await waitFor(
      () => expect(screen.getByTestId("plugin-detail-error")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});

describe("PluginDetailPanel — capability type", () => {
  const capabilityData = {
    id: "oxagen/media-svg",
    name: "oxagen/media-svg",
    title: "SVG Generation",
    description: "Generate SVG images from text prompts",
    version: "1.0.0",
    categories: ["media"],
    tier: "free" as const,
    installed: false,
  };

  const capabilityProps = {
    catalogId: "oxagen/media-svg",
    orgSlug: "acme",
    pluginType: "capability" as const,
    isDenied: false,
    capabilityData,
    installAction: vi.fn().mockResolvedValue({ ok: true, orgListingId: "ol-cap-1" }),
    onInstalled: vi.fn(),
    onClose: vi.fn(),
  };

  it("does not fetch /api/v1/plugin/catalog/get when capabilityData is provided", () => {
    render(<PluginDetailPanel {...capabilityProps} />);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("renders the Free tier badge", () => {
    render(<PluginDetailPanel {...capabilityProps} />);
    expect(screen.getByTestId("plugin-detail-tier-badge")).toBeInTheDocument();
    expect(screen.getByTestId("plugin-detail-tier-badge")).toHaveTextContent("Free");
  });

  it("does not render the README section", () => {
    render(<PluginDetailPanel {...capabilityProps} />);
    expect(screen.queryByTestId("plugin-detail-readme")).not.toBeInTheDocument();
    expect(screen.queryByTestId("plugin-detail-no-readme")).not.toBeInTheDocument();
  });

  it("shows disabled 'Already installed' button when installed:true", () => {
    render(
      <PluginDetailPanel
        {...capabilityProps}
        capabilityData={{ ...capabilityData, installed: true }}
      />,
    );
    const btn = screen.getByTestId("plugin-detail-install-btn");
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/already installed/i);
  });
});
