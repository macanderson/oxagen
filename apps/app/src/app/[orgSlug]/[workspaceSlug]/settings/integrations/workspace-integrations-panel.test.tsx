// @vitest-environment jsdom
/**
 * workspace-integrations-panel.test.tsx — unit tests for WorkspaceIntegrationsPanel.
 *
 * Covers:
 *   (a) Empty state renders "No integrations yet" when orgListings is empty
 *   (b) Renders each listing with its name in the table
 *   (c) Toggle disabled when canManage=false
 *   (d) Toggle disabled when listing.enabled=false (org disabled)
 *   (e) Successful toggle calls setEnabledAction with correct args
 *   (f) Toggle error shows error message in the row
 *   (g) Secret form: "Set API key" button appears for authKind=secret + canManage=true
 *   (h) Secret form open/save calls setSecretAction with trimmed value
 *   (i) Secret form shows error when setSecretAction returns ok:false
 *   (j) Secret form shows validation error when submitted empty
 *   (k) Secret form cancel closes it
 *   (l) OAuth row renders "Connect" button when no install exists
 *   (m) OAuth row renders "Reconnect" + "connected" indicator when install exists
 *   (n) Health icons render based on healthStatus
 *   (o) Credential column hidden when canManage=false
 */

import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    className: _c,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    width: _w,
    height: _h,
    unoptimized: _u,
    className: _c,
    ...rest
  }: {
    src: string;
    alt: string;
    width?: number;
    height?: number;
    unoptimized?: boolean;
    className?: string;
    [key: string]: unknown;
  }) => <img src={src} alt={alt} {...(rest as object)} />,
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    disabled,
    "aria-label": ariaLabel,
    "data-testid": testId,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
    />
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant: _v,
    size: _s,
    className: _c,
    "data-testid": testId,
    render: renderProp,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
    "data-testid"?: string;
    render?: React.ReactElement;
  }) => {
    if (renderProp) {
      return React.cloneElement(renderProp, {
        "data-testid": testId,
        children,
      } as Record<string, unknown>);
    }
    return (
      <button onClick={onClick} disabled={disabled} data-testid={testId}>
        {children}
      </button>
    );
  },
}));

vi.mock("@/components/ui/input", () => ({
  Input: ({
    value,
    onChange,
    placeholder,
    disabled,
    type,
    "data-testid": testId,
    className: _c,
    autoComplete: _ac,
  }: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    placeholder?: string;
    disabled?: boolean;
    type?: string;
    "data-testid"?: string;
    className?: string;
    autoComplete?: string;
  }) => (
    <input
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      type={type}
      data-testid={testId}
    />
  ),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant: _v,
    size: _s,
  }: {
    children: React.ReactNode;
    variant?: string;
    size?: string;
  }) => <span>{children}</span>,
}));

vi.mock("@/lib/routes", () => ({
  org: {
    settings: {
      plugins: ({ orgSlug }: { orgSlug: string }) =>
        `/${orgSlug}/settings/plugins`,
    },
  },
}));

vi.mock("@/lib/plugin-icon", () => ({
  isRenderableImageUrl: (url: unknown) =>
    typeof url === "string" && url.startsWith("https://"),
}));

vi.mock("@oxagen/database", () => ({
  schema: {
    pluginInstalledPlugins: {},
  },
}));

vi.mock("lucide-react", () => new Proxy({} as Record<string | symbol, unknown>, {
  // HealthIcon passes aria-label to the lucide icon and the tests query it via
  // getByLabelText — forward aria-label (and don't set aria-hidden, which would
  // remove the element from the accessibility tree).
  get: (_t, prop) =>
    prop === "then"
      ? undefined
      : (props: { "aria-label"?: string }) => (
          <svg data-icon={String(prop)} aria-label={props?.["aria-label"]} />
        ),
  has: (_t, prop) => prop !== "then",
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import {
  WorkspaceIntegrationsPanel,
  type WorkspaceMcpInstall,
} from "./workspace-integrations-panel";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

// Full shape of pluginInstalledPlugins.$inferSelect based on the schema mixins:
// idMixin (id, publicId) + auditMixin (createdAt, updatedAt, createdByUserId, updatedByUserId)
// + softDeleteMixin (deletedAt, deletedByUserId) + own columns
type OrgListingFixture = {
  id: string;
  publicId: string;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  deletedAt: Date | null;
  deletedByUserId: string | null;
  orgId: string;
  workspaceId: string;
  pluginType: string;
  source: string;
  name: string;
  title: string | null;
  description: string | null;
  iconUrl: string | null;
  endpointUrl: string | null;
  transport: string | null;
  authKind: string;
  authConfig: Record<string, unknown>;
  enabled: boolean;
  config: Record<string, unknown>;
};

function makeListing(overrides: Partial<OrgListingFixture> = {}): OrgListingFixture {
  return {
    id: "listing-1",
    publicId: "porg_listing1",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
    createdByUserId: null,
    updatedByUserId: null,
    deletedAt: null,
    deletedByUserId: null,
    orgId: "org-1",
    workspaceId: "ws-1",
    pluginType: "mcp_server",
    source: "registry",
    name: "my-plugin",
    title: "My Plugin",
    description: null,
    iconUrl: null,
    endpointUrl: null,
    transport: null,
    authKind: "none",
    authConfig: {},
    enabled: true,
    config: {},
    ...overrides,
  };
}

function makeInstall(overrides: Partial<WorkspaceMcpInstall> = {}): WorkspaceMcpInstall {
  return {
    orgListingId: "listing-1",
    enabled: false,
    healthStatus: "unknown",
    lastHealthcheckAt: null,
    ...overrides,
  };
}

const DEFAULT_PROPS = {
  orgSlug: "acme",
  workspaceSlug: "main",
  canManage: true,
  orgListings: [] as OrgListingFixture[],
  wsInstallMap: {} as Record<string, WorkspaceMcpInstall>,
  setEnabledAction: vi.fn(async () => ({ ok: true as const })),
  setSecretAction: vi.fn(async () => ({ ok: true as const })),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceIntegrationsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Empty state
  it("renders empty state when orgListings is empty", () => {
    render(<WorkspaceIntegrationsPanel {...DEFAULT_PROPS} />);
    expect(screen.getByTestId("integrations-empty-state")).toBeInTheDocument();
    expect(screen.getByText("No integrations yet")).toBeInTheDocument();
  });

  // Empty state link to org settings
  it("empty state links to org settings plugins page", () => {
    render(<WorkspaceIntegrationsPanel {...DEFAULT_PROPS} />);
    const link = screen.getByRole("link", { name: /Org Settings → Plugins/i });
    expect(link).toHaveAttribute("href", "/acme/settings/plugins");
  });

  // (b) Renders each listing with its name
  it("renders the listing title in the table row", () => {
    const listing = makeListing({ title: "My Integration", name: "my-integration" });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
      />,
    );
    expect(screen.getByText("My Integration")).toBeInTheDocument();
  });

  it("falls back to listing.name when title is null", () => {
    const listing = makeListing({ title: null, name: "raw-name" });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
      />,
    );
    expect(screen.getAllByText("raw-name").length).toBeGreaterThan(0);
  });

  // (c) Toggle disabled when canManage=false
  it("toggle is disabled when canManage=false", () => {
    const listing = makeListing();
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        canManage={false}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall({ enabled: true }) }}
      />,
    );
    const toggle = screen.getByTestId(`integrations-toggle-${listing.id}`);
    expect(toggle).toBeDisabled();
  });

  // (d) Toggle disabled when listing.enabled=false (org disabled)
  it("toggle is disabled when listing.enabled=false (org disabled)", () => {
    const listing = makeListing({ enabled: false });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
      />,
    );
    const toggle = screen.getByTestId(`integrations-toggle-${listing.id}`);
    expect(toggle).toBeDisabled();
    // "(org disabled)" indicator should appear
    expect(screen.getByText(/org disabled/)).toBeInTheDocument();
  });

  // (e) Successful toggle calls setEnabledAction
  it("enabling the toggle calls setEnabledAction with enabled=true", async () => {
    const listing = makeListing();
    const setEnabledAction = vi.fn(async () => ({ ok: true as const }));
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall({ enabled: false }) }}
        setEnabledAction={setEnabledAction}
      />,
    );

    const toggle = screen.getByTestId(`integrations-toggle-${listing.id}`);
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(setEnabledAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: listing.id,
      enabled: true,
    });
  });

  it("disabling the toggle calls setEnabledAction with enabled=false", async () => {
    const listing = makeListing();
    const setEnabledAction = vi.fn(async () => ({ ok: true as const }));
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall({ enabled: true }) }}
        setEnabledAction={setEnabledAction}
      />,
    );

    const toggle = screen.getByTestId(`integrations-toggle-${listing.id}`);
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(setEnabledAction).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  // (f) Toggle error shows error message
  it("shows error message when setEnabledAction returns ok=false", async () => {
    const listing = makeListing();
    const setEnabledAction = vi.fn(async () => ({
      ok: false as const,
      error: "Server error",
    }));
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall({ enabled: false }) }}
        setEnabledAction={setEnabledAction}
      />,
    );

    const toggle = screen.getByTestId(`integrations-toggle-${listing.id}`);
    await act(async () => {
      fireEvent.click(toggle);
    });

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });
  });

  // (g) Secret form "Set API key" button for authKind=secret + canManage
  it("renders 'Set API key' button for authKind=secret when canManage=true", () => {
    const listing = makeListing({ authKind: "secret" });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
      />,
    );
    expect(
      screen.getByTestId(`integrations-set-secret-btn-${listing.id}`),
    ).toBeInTheDocument();
  });

  // Not shown when canManage=false
  it("does NOT render 'Set API key' when canManage=false", () => {
    const listing = makeListing({ authKind: "secret" });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        canManage={false}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
      />,
    );
    expect(
      screen.queryByTestId(`integrations-set-secret-btn-${listing.id}`),
    ).not.toBeInTheDocument();
  });

  // (h) Secret form open and save calls setSecretAction
  it("opening secret form and saving calls setSecretAction with trimmed value", async () => {
    const listing = makeListing({ authKind: "secret" });
    const setSecretAction = vi.fn(async () => ({ ok: true as const }));
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
        setSecretAction={setSecretAction}
      />,
    );

    // Open the form
    fireEvent.click(screen.getByTestId(`integrations-set-secret-btn-${listing.id}`));

    // Type a secret
    const secretInput = screen.getByTestId(
      `integrations-secret-input-${listing.id}`,
    );
    fireEvent.change(secretInput, { target: { value: "  my-api-key  " } });

    // Click Save
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(setSecretAction).toHaveBeenCalledWith({
      orgSlug: "acme",
      workspaceSlug: "main",
      orgListingId: listing.id,
      secret: "my-api-key",
    });
  });

  // (i) Secret form shows error from setSecretAction
  it("shows error from setSecretAction when ok=false", async () => {
    const listing = makeListing({ authKind: "secret" });
    const setSecretAction = vi.fn(async () => ({
      ok: false as const,
      error: "Invalid key",
    }));
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
        setSecretAction={setSecretAction}
      />,
    );

    fireEvent.click(screen.getByTestId(`integrations-set-secret-btn-${listing.id}`));
    const secretInput = screen.getByTestId(
      `integrations-secret-input-${listing.id}`,
    );
    fireEvent.change(secretInput, { target: { value: "bad-key" } });

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    await waitFor(() => {
      expect(screen.getByText("Invalid key")).toBeInTheDocument();
    });
  });

  // (j) Secret form shows validation error when submitted empty
  it("shows 'Secret is required' when submitting empty secret form", async () => {
    const listing = makeListing({ authKind: "secret" });
    const setSecretAction = vi.fn(async () => ({ ok: true as const }));
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
        setSecretAction={setSecretAction}
      />,
    );

    fireEvent.click(screen.getByTestId(`integrations-set-secret-btn-${listing.id}`));

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    expect(screen.getByText("Secret is required.")).toBeInTheDocument();
    expect(setSecretAction).not.toHaveBeenCalled();
  });

  // (k) Secret form cancel closes it
  it("cancel closes the secret form", async () => {
    const listing = makeListing({ authKind: "secret" });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
      />,
    );

    fireEvent.click(screen.getByTestId(`integrations-set-secret-btn-${listing.id}`));
    // Form is open
    expect(
      screen.getByTestId(`integrations-secret-form-${listing.id}`),
    ).toBeInTheDocument();

    // Cancel closes it
    fireEvent.click(screen.getByText("Cancel"));
    expect(
      screen.queryByTestId(`integrations-secret-form-${listing.id}`),
    ).not.toBeInTheDocument();
    // Button should be back
    expect(
      screen.getByTestId(`integrations-set-secret-btn-${listing.id}`),
    ).toBeInTheDocument();
  });

  // (l) OAuth row renders "Connect" when no install
  it("renders 'Connect' OAuth button when no install exists", () => {
    const listing = makeListing({ authKind: "oauth" });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{}}
      />,
    );
    expect(screen.getByText("Connect")).toBeInTheDocument();
  });

  // (m) OAuth row renders "Reconnect" + "connected" indicator when install exists
  it("renders 'Reconnect' and 'connected' status when install exists", () => {
    const listing = makeListing({ authKind: "oauth" });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall({ enabled: true }) }}
      />,
    );
    expect(screen.getByText("Reconnect")).toBeInTheDocument();
    expect(
      screen.getByTestId(`plugin-auth-status-${listing.id}`),
    ).toBeInTheDocument();
    expect(screen.getByText("connected")).toBeInTheDocument();
  });

  // (n) Health icons render based on healthStatus
  it("renders healthy icon when healthStatus=healthy", () => {
    const listing = makeListing();
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{
          [listing.id]: makeInstall({ healthStatus: "healthy" }),
        }}
      />,
    );
    // HealthIcon renders CheckCircle2 with aria-label="Healthy"
    expect(screen.getByLabelText("Healthy")).toBeInTheDocument();
  });

  it("renders error icon when healthStatus=error", () => {
    const listing = makeListing();
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{
          [listing.id]: makeInstall({ healthStatus: "error" }),
        }}
      />,
    );
    expect(screen.getByLabelText("Error")).toBeInTheDocument();
  });

  it("renders 'Not configured' icon for unknown health status", () => {
    const listing = makeListing();
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{
          [listing.id]: makeInstall({ healthStatus: "pending" }),
        }}
      />,
    );
    expect(screen.getByLabelText("Not configured")).toBeInTheDocument();
  });

  // (o) Credential column hidden when canManage=false
  it("does not render credential column when canManage=false", () => {
    const listing = makeListing({ authKind: "secret" });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        canManage={false}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
      />,
    );
    // "Credential" header should not exist
    expect(screen.queryByText("Credential")).not.toBeInTheDocument();
  });

  // Image renders when iconUrl is https://
  it("renders img when iconUrl starts with https://", () => {
    const listing = makeListing({ iconUrl: "https://cdn.example.com/icon.png" });
    render(
      <WorkspaceIntegrationsPanel
        {...DEFAULT_PROPS}
        orgListings={[listing]}
        wsInstallMap={{ [listing.id]: makeInstall() }}
      />,
    );
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("src", "https://cdn.example.com/icon.png");
  });
});
