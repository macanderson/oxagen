// @vitest-environment jsdom
/**
 * workspace-plugins-panel.test.tsx — component tests for WorkspacePluginsPanel.
 *
 * Covers:
 *   - Empty state: renders "No plugins installed" + empty-state marketplace button.
 *   - Plugins list: renders plugin row with name for each installed plugin.
 *   - Browse Marketplace button: clicking it opens MarketplaceModal.
 *   - Toggle enabled: calls toggleAction with correct args when switching a plugin.
 *   - Toggle optimistic update + error revert: shows error message when toggleAction fails.
 *   - Uninstall confirm cancel: window.confirm=false does NOT call uninstallAction.
 *   - Uninstall confirm success: confirm + uninstall removes the row from the DOM.
 *   - Uninstall error: when uninstallAction fails, the error message appears.
 *   - Icon as img: plugin with https:// iconUrl renders an <img> element.
 *   - Icon fallback: plugin with null iconUrl renders the SVG icon fallback.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import {
  WorkspacePluginsPanel,
  type InstalledPlugin,
} from "./workspace-plugins-panel";
import type { RegistryRow } from "./registry-manager";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    <img src={src} alt={alt} />
  ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    "aria-label": ariaLabel,
    ...rest
  }: {
    checked: boolean;
    onCheckedChange: (c: boolean) => void;
    disabled?: boolean;
    "aria-label"?: string;
    [k: string]: unknown;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
      disabled={disabled}
      aria-label={ariaLabel}
      {...(rest as object)}
    />
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => (
    <button onClick={onClick} disabled={disabled} {...(rest as object)}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    ...rest
  }: {
    children: React.ReactNode;
    [k: string]: unknown;
  }) => <span {...(rest as object)}>{children}</span>,
}));

vi.mock("@/components/plugins/marketplace-modal", () => ({
  MarketplaceModal: ({ open }: { open: boolean }) =>
    open ? (
      <div data-testid="marketplace-modal">Marketplace</div>
    ) : null,
}));

vi.mock("./registry-manager", () => ({
  RegistryManager: () => <div data-testid="registry-manager" />,
}));

vi.mock("@/lib/plugin-icon", () => ({
  isRenderableImageUrl: (url: unknown) =>
    typeof url === "string" && url.startsWith("https://"),
}));

vi.mock("lucide-react", () => new Proxy({} as Record<string | symbol, unknown>, {
  get: (_t, prop) => {
    if (prop === "__esModule") return true;
    if (typeof prop === "symbol") return undefined;
    return () => <svg aria-hidden="true" data-icon={String(prop)} />;
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PLUGIN: InstalledPlugin = {
  id: "plugin-1",
  name: "my-plugin",
  title: "My Plugin",
  description: "Does things",
  iconUrl: null,
  pluginType: "mcp_server",
  authKind: "none",
  enabled: true,
  wsEnabled: true,
};

const EMPTY_REGISTRIES: RegistryRow[] = [];

type ToggleInput = {
  orgSlug: string;
  workspaceSlug: string;
  orgListingId: string;
  enabled: boolean;
};

type UninstallInput = {
  orgSlug: string;
  workspaceSlug: string;
  orgListingId: string;
};

type InstallInput = {
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  catalogServerId: string;
  pluginType:
    | "mcp_server"
    | "integration"
    | "content_tool"
    | "capability"
    | "agent_skill"
    | "agent_capability"
    | "knowledge_source";
  pluginId?: string;
};

type InstallBulkInput = {
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  items: Array<{
    catalogServerId?: string;
    pluginType:
      | "mcp_server"
      | "integration"
      | "content_tool"
      | "capability"
      | "agent_skill"
      | "agent_capability"
      | "knowledge_source";
    pluginId?: string;
  }>;
};

type AddRegistryInput = {
  orgSlug: string;
  workspaceSlug: string;
  name: string;
  baseUrl: string;
};

type RemoveRegistryInput = {
  orgSlug: string;
  workspaceSlug: string;
  registryId: string;
};

function makeActions(overrides: {
  toggleAction?: (input: ToggleInput) => Promise<{ ok: boolean; error?: string }>;
  uninstallAction?: (input: UninstallInput) => Promise<{ ok: boolean; error?: string }>;
} = {}) {
  return {
    installAction: vi.fn((_input: InstallInput) =>
      Promise.resolve({ ok: true as const, orgListingId: "new-listing" }),
    ),
    installBulkAction: vi.fn((_input: InstallBulkInput) =>
      Promise.resolve({ ok: true as const }),
    ),
    toggleAction: vi.fn((_input: ToggleInput) =>
      Promise.resolve({ ok: true as const }),
    ),
    uninstallAction: vi.fn((_input: UninstallInput) =>
      Promise.resolve({ ok: true as const }),
    ),
    addRegistryAction: vi.fn((_input: AddRegistryInput) =>
      Promise.resolve({ ok: true as const }),
    ),
    removeRegistryAction: vi.fn((_input: RemoveRegistryInput) =>
      Promise.resolve({ ok: true as const, promotedId: null }),
    ),
    ...overrides,
  };
}

function renderPanel(
  plugins: InstalledPlugin[],
  actions: ReturnType<typeof makeActions>,
) {
  return render(
    <WorkspacePluginsPanel
      orgSlug="my-org"
      workspaceSlug="my-workspace"
      orgId="org-id-1"
      workspaceId="ws-id-1"
      initialPlugins={plugins}
      initialRegistries={EMPTY_REGISTRIES}
      docsBaseUrl="https://docs.example.com"
      {...actions}
    />,
  );
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

afterEach(cleanup);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WorkspacePluginsPanel — empty state", () => {
  it("renders 'No plugins installed' message and empty-state marketplace button when initialPlugins is empty", () => {
    renderPanel([], makeActions());

    expect(
      screen.getByText(/no plugins installed/i),
    ).toBeInTheDocument();

    expect(
      screen.getByTestId("ws-browse-marketplace-empty-btn"),
    ).toBeInTheDocument();
  });
});

describe("WorkspacePluginsPanel — plugins list", () => {
  it("renders a row for each installed plugin with its display name", () => {
    const plugins: InstalledPlugin[] = [
      { ...PLUGIN, id: "p1", name: "plugin-one", title: "Plugin One" },
      { ...PLUGIN, id: "p2", name: "plugin-two", title: "Plugin Two" },
    ];

    renderPanel(plugins, makeActions());

    expect(screen.getByTestId("ws-plugin-name-p1")).toHaveTextContent("Plugin One");
    expect(screen.getByTestId("ws-plugin-name-p2")).toHaveTextContent("Plugin Two");
    expect(screen.getByTestId("ws-plugin-row-p1")).toBeInTheDocument();
    expect(screen.getByTestId("ws-plugin-row-p2")).toBeInTheDocument();
  });
});

describe("WorkspacePluginsPanel — browse marketplace button", () => {
  it("opens MarketplaceModal when Browse Marketplace header button is clicked", async () => {
    const user = userEvent.setup();
    renderPanel([PLUGIN], makeActions());

    expect(screen.queryByTestId("marketplace-modal")).not.toBeInTheDocument();

    await act(async () => {
      await user.click(screen.getByTestId("ws-browse-marketplace-btn"));
    });

    expect(screen.getByTestId("marketplace-modal")).toBeInTheDocument();
  });
});

describe("WorkspacePluginsPanel — toggle enabled", () => {
  it("calls toggleAction with correct args when disabling a plugin", async () => {
    const user = userEvent.setup();
    const actions = makeActions();

    renderPanel([{ ...PLUGIN, wsEnabled: true }], actions);

    const toggle = screen.getByTestId("ws-plugin-toggle-plugin-1");

    await act(async () => {
      await user.click(toggle);
    });

    expect(actions.toggleAction).toHaveBeenCalledOnce();
    expect(actions.toggleAction).toHaveBeenCalledWith({
      orgSlug: "my-org",
      workspaceSlug: "my-workspace",
      orgListingId: "plugin-1",
      enabled: false,
    });
  });

  it("calls toggleAction with enabled=true when enabling a disabled plugin", async () => {
    const user = userEvent.setup();
    const actions = makeActions();

    renderPanel([{ ...PLUGIN, wsEnabled: false, enabled: false }], actions);

    const toggle = screen.getByTestId("ws-plugin-toggle-plugin-1");

    await act(async () => {
      await user.click(toggle);
    });

    expect(actions.toggleAction).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});

describe("WorkspacePluginsPanel — toggle optimistic update + error revert", () => {
  it("shows error message in the row when toggleAction returns ok: false", async () => {
    const user = userEvent.setup();
    const actions = makeActions({
      toggleAction: vi.fn(() =>
        Promise.resolve({ ok: false, error: "Update failed" }),
      ),
    });

    renderPanel([PLUGIN], actions);

    await act(async () => {
      await user.click(screen.getByTestId("ws-plugin-toggle-plugin-1"));
    });

    await waitFor(() => {
      expect(screen.getByText("Update failed")).toBeInTheDocument();
    });
  });
});

describe("WorkspacePluginsPanel — uninstall confirm cancel", () => {
  it("does NOT call uninstallAction when window.confirm is cancelled", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const actions = makeActions();

    renderPanel([PLUGIN], actions);

    await act(async () => {
      await user.click(screen.getByTestId("ws-plugin-remove-btn-plugin-1"));
    });

    expect(actions.uninstallAction).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });
});

describe("WorkspacePluginsPanel — uninstall confirm success", () => {
  it("calls uninstallAction and removes the plugin row after confirming", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const actions = makeActions();

    renderPanel([PLUGIN], actions);

    expect(screen.getByTestId("ws-plugin-row-plugin-1")).toBeInTheDocument();

    await act(async () => {
      await user.click(screen.getByTestId("ws-plugin-remove-btn-plugin-1"));
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId("ws-plugin-row-plugin-1"),
      ).not.toBeInTheDocument();
    });

    expect(actions.uninstallAction).toHaveBeenCalledOnce();
    expect(actions.uninstallAction).toHaveBeenCalledWith({
      orgSlug: "my-org",
      workspaceSlug: "my-workspace",
      orgListingId: "plugin-1",
    });

    confirmSpy.mockRestore();
  });
});

describe("WorkspacePluginsPanel — uninstall error", () => {
  it("shows error message in the row when uninstallAction returns ok: false", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const actions = makeActions({
      uninstallAction: vi.fn(() =>
        Promise.resolve({ ok: false, error: "Uninstall failed" }),
      ),
    });

    renderPanel([PLUGIN], actions);

    await act(async () => {
      await user.click(screen.getByTestId("ws-plugin-remove-btn-plugin-1"));
    });

    await waitFor(() => {
      expect(screen.getByText("Uninstall failed")).toBeInTheDocument();
    });

    // Row stays in DOM on error
    expect(screen.getByTestId("ws-plugin-row-plugin-1")).toBeInTheDocument();

    confirmSpy.mockRestore();
  });
});

describe("WorkspacePluginsPanel — icon rendering", () => {
  it("renders an <img> element when iconUrl is a renderable https:// URL", () => {
    const pluginWithIcon: InstalledPlugin = {
      ...PLUGIN,
      id: "plugin-icon",
      iconUrl: "https://cdn.example.com/icon.png",
    };

    renderPanel([pluginWithIcon], makeActions());

    const row = screen.getByTestId("ws-plugin-row-plugin-icon");
    const img = row.querySelector("img");

    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://cdn.example.com/icon.png");
  });

  it("renders SVG icon fallback (data-icon attribute) when iconUrl is null", () => {
    const pluginNoIcon: InstalledPlugin = {
      ...PLUGIN,
      id: "plugin-no-icon",
      iconUrl: null,
    };

    renderPanel([pluginNoIcon], makeActions());

    const row = screen.getByTestId("ws-plugin-row-plugin-no-icon");
    const svg = row.querySelector("svg[data-icon]");

    expect(svg).not.toBeNull();
    // No <img> should be rendered for the icon slot
    expect(row.querySelector("img")).toBeNull();
  });
});
