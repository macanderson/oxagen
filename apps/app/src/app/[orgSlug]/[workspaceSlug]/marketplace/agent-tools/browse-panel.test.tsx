// @vitest-environment jsdom
/**
 * browse-panel.test.tsx — the Marketplace → Agent Tools bulk-install fix.
 *
 * Regression cover for the fictional-bulk-install defect: the page received
 * `installBulkAction` as a prop and `void`-ed it, so no multi-select UI existed
 * and the `install_plugins_bulk` capability had no working app surface. These
 * tests exercise the real multi-select → "Install selected" flow:
 *
 *   (a) checking cards reveals the selection toolbar with a live count
 *   (b) "Install selected" dispatches installBulkAction with each selected
 *       card resolved to its install *name* (not the compound catalog id) and
 *       the active tab's pluginType, then marks the rows installed
 *   (c) a partial failure surfaces the per-item errors inline (bulk install is
 *       not all-or-nothing) and does NOT flip the rows to installed
 *
 * Renders real @/components/ui/* in jsdom (same convention as
 * mcp-server-list.test.tsx). fetch + tenant + toast are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/tenant/tenant-context", () => ({
  useTenant: () => ({ workspaceId: "ws-1", orgSlug: "acme" }),
}));

const toastAdd = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}));

import { BrowsePanel } from "./browse-panel";

type CatalogServer = {
  id: string;
  name: string;
  title: string | null;
  description: string;
  icons: Array<{ src: string; color?: string }>;
  transportTypes: string[];
  authKind: string;
  categories: string[];
  version: string;
  pluginType: "agent_skill" | "mcp_server" | "agent_capability";
  tier?: "free" | "premium";
  installed?: boolean;
};

function makeServer(overrides: Partial<CatalogServer> = {}): CatalogServer {
  return {
    id: "reg:web-scraper:1.0.0",
    name: "web-scraper",
    title: "Web Scraper",
    description: "Scrape and summarise web pages.",
    icons: [],
    transportTypes: [],
    authKind: "none",
    categories: ["research"],
    version: "1.0.0",
    pluginType: "agent_skill",
    tier: "free",
    installed: false,
    ...overrides,
  };
}

function mockCatalog(servers: CatalogServer[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ servers, nextOffset: null, total: servers.length }),
      text: async () => "",
    })),
  );
}

beforeEach(() => {
  toastAdd.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const A = makeServer({
  id: "reg:web-scraper:1.0.0",
  name: "web-scraper",
  title: "Web Scraper",
});
const B = makeServer({
  id: "reg:pdf-parser:2.1.0",
  name: "pdf-parser",
  title: "PDF Parser",
});

describe("BrowsePanel — bulk install", () => {
  it("reveals a selection toolbar with a live count as cards are checked", async () => {
    const user = userEvent.setup();
    mockCatalog([A, B]);
    render(
      <BrowsePanel
        orgSlug="acme"
        workspaceSlug="main"
        installAction={vi.fn(async () => ({ ok: true }))}
        installBulkAction={vi.fn(async () => ({ ok: true }))}
      />,
    );

    // Toolbar hidden until something is selected.
    await screen.findByTestId(`marketplace-browse-card-${A.id}`);
    expect(
      screen.queryByTestId("marketplace-browse-selection-toolbar"),
    ).not.toBeInTheDocument();

    await user.click(screen.getByTestId(`marketplace-browse-select-${A.id}`));
    expect(
      screen.getByTestId("marketplace-browse-selection-count"),
    ).toHaveTextContent("1 selected");

    await user.click(screen.getByTestId(`marketplace-browse-select-${B.id}`));
    expect(
      screen.getByTestId("marketplace-browse-selection-count"),
    ).toHaveTextContent("2 selected");
  });

  it("dispatches installBulkAction with resolved names + tab pluginType and marks rows installed", async () => {
    const user = userEvent.setup();
    mockCatalog([A, B]);
    const installBulk = vi.fn(async () => ({ ok: true }));
    render(
      <BrowsePanel
        orgSlug="acme"
        workspaceSlug="main"
        installAction={vi.fn(async () => ({ ok: true }))}
        installBulkAction={installBulk}
      />,
    );

    await screen.findByTestId(`marketplace-browse-card-${A.id}`);
    await user.click(screen.getByTestId(`marketplace-browse-select-${A.id}`));
    await user.click(screen.getByTestId(`marketplace-browse-select-${B.id}`));
    await user.click(screen.getByTestId("marketplace-browse-bulk-install-btn"));

    await waitFor(() => expect(installBulk).toHaveBeenCalledTimes(1));
    expect(installBulk).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      items: [
        { catalogServerId: "web-scraper", pluginType: "agent_skill" },
        { catalogServerId: "pdf-parser", pluginType: "agent_skill" },
      ],
    });

    // Rows flip to installed → checkboxes disappear, selection clears.
    await waitFor(() =>
      expect(
        screen.queryByTestId("marketplace-browse-selection-toolbar"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByTestId(`marketplace-browse-installed-badge-${A.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`marketplace-browse-installed-badge-${B.id}`),
    ).toBeInTheDocument();
  });

  it("surfaces per-item failures inline and keeps rows uninstalled on partial failure", async () => {
    const user = userEvent.setup();
    mockCatalog([A, B]);
    const installBulk = vi.fn(async () => ({
      ok: false,
      error: "1 of 2 plugin(s) failed to install",
      failures: ["pdf-parser: registry unreachable"],
    }));
    render(
      <BrowsePanel
        orgSlug="acme"
        workspaceSlug="main"
        installAction={vi.fn(async () => ({ ok: true }))}
        installBulkAction={installBulk}
      />,
    );

    await screen.findByTestId(`marketplace-browse-card-${A.id}`);
    await user.click(screen.getByTestId(`marketplace-browse-select-${A.id}`));
    await user.click(screen.getByTestId(`marketplace-browse-select-${B.id}`));
    await user.click(screen.getByTestId("marketplace-browse-bulk-install-btn"));

    // Per-item failures render in the toolbar; selection is retained.
    const failures = await screen.findByTestId(
      "marketplace-browse-bulk-failures",
    );
    expect(failures).toHaveTextContent("pdf-parser: registry unreachable");
    expect(
      screen.getByTestId("marketplace-browse-selection-toolbar"),
    ).toBeInTheDocument();

    // No optimistic install badge on a failed bulk run.
    expect(
      screen.queryByTestId(`marketplace-browse-installed-badge-${A.id}`),
    ).not.toBeInTheDocument();
  });
});

describe("BrowsePanel — terminal states", () => {
  it("renders a shared EmptyState (not the skeleton) when the catalog is empty", async () => {
    mockCatalog([]);
    render(
      <BrowsePanel
        orgSlug="acme"
        workspaceSlug="main"
        installAction={vi.fn(async () => ({ ok: true }))}
        installBulkAction={vi.fn(async () => ({ ok: true }))}
      />,
    );

    const empty = await screen.findByTestId("marketplace-browse-empty");
    expect(empty).toHaveTextContent("No plugins available");
    // The loading skeleton must not be the terminal state.
    expect(
      screen.queryByTestId("marketplace-browse-skeleton"),
    ).not.toBeInTheDocument();
  });

  it("renders a retryable ErrorState when the catalog fetch fails", async () => {
    const fetchMock = vi
      .fn()
      // First call fails; the retry succeeds with one plugin.
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
        text: async () => "registry unreachable",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ servers: [A], nextOffset: null, total: 1 }),
        text: async () => "",
      });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(
      <BrowsePanel
        orgSlug="acme"
        workspaceSlug="main"
        installAction={vi.fn(async () => ({ ok: true }))}
        installBulkAction={vi.fn(async () => ({ ok: true }))}
      />,
    );

    // ErrorState (role="alert") instead of a stranded skeleton or empty state.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load skills");
    expect(alert).toHaveTextContent("registry unreachable");
    expect(
      screen.queryByTestId("marketplace-browse-skeleton"),
    ).not.toBeInTheDocument();

    // Retry re-fetches and recovers to the grid.
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId(`marketplace-browse-card-${A.id}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
