"use client";
import * as React from "react";
import Image from "next/image";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  ShoppingBag,
  Trash2,
  Plus,
  Plug,
  Globe,
  Package,
  FileText,
  Boxes,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { MarketplaceModal } from "@/components/plugins/marketplace-modal";
import { isRenderableImageUrl } from "@/lib/plugin-icon";
import type { schema } from "@oxagen/database";

// ── Types ─────────────────────────────────────────────────────────────────────

type OrgListing = typeof schema.pluginOrgListings.$inferSelect;
type DenylistEntry = typeof schema.pluginOrgDenylist.$inferSelect;

interface Registry {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  isDefaultSeed: boolean;
  lastSyncedAt: string | null;
}

interface OrgPluginsPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  canManage: boolean;
  registries: Registry[];
  listings: OrgListing[];
  denylisted: DenylistEntry[];
  initialSendEmail: boolean;
  initialAlertRoles: string[];
  setAuthAlertsAction: (input: {
    orgSlug: string;
    sendEmail: boolean;
    roles: string[];
  }) => Promise<{ ok: boolean; error?: string }>;
  /** Install a catalog-based plugin (from the marketplace modal). */
  installCatalogAction: (input: {
    orgSlug: string;
    workspaceId: string;
    catalogServerId: string;
    pluginType: "mcp_server" | "integration" | "content_tool" | "capability";
    pluginId?: string;
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  /** Install a custom MCP server (from the custom plugin form). */
  installAction: (input: {
    orgSlug: string;
    pluginType: "mcp_server" | "integration" | "content_tool";
    custom: {
      name: string;
      title?: string;
      description?: string;
      endpointUrl: string;
      transport: string;
      authKind: "oauth" | "secret" | "none";
    };
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  installBulkAction: (input: {
    orgSlug: string;
    workspaceId: string;
    items: Array<{
      catalogServerId?: string;
      pluginType: "mcp_server" | "integration" | "content_tool" | "capability";
      pluginId?: string;
    }>;
  }) => Promise<{
    ok: boolean;
    installed?: Array<{
      catalogServerId: string | null;
      orgListingId: string | null;
      error: string | null;
    }>;
    error?: string;
  }>;
  setEnabledAction: (input: {
    orgSlug: string;
    orgListingId: string;
    enabled: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  uninstallAction: (input: {
    orgSlug: string;
    orgListingId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  addDenylistAction: (input: {
    orgSlug: string;
    serverName: string;
    pluginType: "mcp_server" | "integration" | "content_tool" | "capability";
    reason?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  removeDenylistAction: (input: {
    orgSlug: string;
    serverName: string;
    pluginType: "mcp_server" | "integration" | "content_tool" | "capability";
  }) => Promise<{ ok: boolean; error?: string }>;
  addRegistryAction: (input: {
    orgSlug: string;
    name: string;
    baseUrl: string;
  }) => Promise<{ ok: boolean; registryId?: string; error?: string }>;
  removeRegistryAction: (input: {
    orgSlug: string;
    registryId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pluginTypeIcon(type: string) {
  if (type === "integration") return <Package className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  if (type === "content_tool") return <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  if (type === "capability") return <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  return <Plug className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
}

function pluginTypeBadgeVariant(type: string): "outline" | "muted" | "secondary" | "info" {
  if (type === "integration") return "muted";
  if (type === "content_tool") return "secondary";
  if (type === "capability") return "info";
  return "outline";
}

function authKindBadgeVariant(kind: string): "info" | "warning" | "muted" {
  if (kind === "oauth") return "info";
  if (kind === "secret") return "warning";
  return "muted";
}

// ── Section card wrapper ──────────────────────────────────────────────────────

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-6">
      <h3 className="mb-1 text-sm font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mb-4 text-xs text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}

// ── RegistriesSection ─────────────────────────────────────────────────────────

function RegistriesSection({
  orgSlug,
  canManage,
  registries,
  addRegistryAction,
  removeRegistryAction,
}: Pick<OrgPluginsPanelProps, "orgSlug" | "canManage" | "registries" | "addRegistryAction" | "removeRegistryAction">) {
  const [showForm, setShowForm] = React.useState(false);
  const [name, setName] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleAdd = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      setError("Name and URL are required.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await addRegistryAction({ orgSlug, name: name.trim(), baseUrl: baseUrl.trim() });
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Failed to add registry");
      return;
    }
    setName("");
    setBaseUrl("");
    setShowForm(false);
  };

  const handleRemove = async (registryId: string) => {
    if (!window.confirm("Remove this registry? Plugins sourced from it will remain installed but won't receive future updates.")) return;
    const result = await removeRegistryAction({ orgSlug, registryId });
    if (!result.ok) setError(result.error ?? "Remove failed");
  };

  return (
    <SectionCard
      title="Plugin Registries"
      description="Registries are sources that Oxagen discovers and installs plugins from. The default seed registry cannot be removed."
    >
      <div className="overflow-hidden rounded-lg border border-border/40">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 bg-muted/30 text-xs text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Name</th>
              <th className="px-4 py-2 text-left font-medium">URL</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              <th className="px-4 py-2 text-left font-medium">Last synced</th>
              {canManage && <th className="px-4 py-2" />}
            </tr>
          </thead>
          <tbody>
            {registries.length === 0 ? (
              <tr>
                <td colSpan={canManage ? 5 : 4} className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No registries configured.
                </td>
              </tr>
            ) : (
              registries.map((reg) => (
                <tr key={reg.id} className="border-b border-border/30 last:border-0">
                  <td className="px-4 py-3 font-medium">
                    <span className="flex items-center gap-2">
                      <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      {reg.name}
                      {reg.isDefaultSeed && (
                        <Badge variant="muted" size="sm">Default</Badge>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground truncate max-w-[220px]">
                    {reg.baseUrl}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={reg.enabled ? "success" : "muted"} size="sm">
                      {reg.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {reg.lastSyncedAt
                      ? new Date(reg.lastSyncedAt).toLocaleDateString()
                      : "Never"}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      {!reg.isDefaultSeed && (
                        <button
                          type="button"
                          onClick={() => handleRemove(reg.id)}
                          className="text-muted-foreground hover:text-destructive transition-colors"
                          aria-label={`Remove ${reg.name} registry`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {canManage && (
        <div className="mt-4">
          {!showForm ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowForm(true)}
              data-testid="add-custom-registry-btn"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Add registry
            </Button>
          ) : (
            <div className="mt-2 flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/20 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="reg-name" className="text-xs">Registry name</Label>
                  <Input
                    id="reg-name"
                    type="text"
                    placeholder="My Registry"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={pending}
                    data-testid="custom-registry-name-input"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="reg-url" className="text-xs">Base URL</Label>
                  <Input
                    id="reg-url"
                    type="url"
                    placeholder="https://registry.example.com"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    disabled={pending}
                    data-testid="custom-registry-url-input"
                  />
                </div>
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleAdd} disabled={pending} data-testid="custom-registry-submit-btn">
                  {pending ? "Adding…" : "Add registry"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setShowForm(false); setError(null); }}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ── AllowListSection ──────────────────────────────────────────────────────────

function AllowListSection({
  orgSlug,
  canManage,
  listings,
  setEnabledAction,
  uninstallAction,
  onBrowseMarketplace,
}: Pick<OrgPluginsPanelProps, "orgSlug" | "canManage" | "listings" | "setEnabledAction" | "uninstallAction"> & {
  onBrowseMarketplace: () => void;
}) {
  const [pendingIds, setPendingIds] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const setError = (id: string, msg: string | null) =>
    setErrors((prev) => {
      const next = { ...prev };
      if (msg === null) delete next[id];
      else next[id] = msg;
      return next;
    });

  const handleToggle = async (listing: OrgListing, enabled: boolean) => {
    setPendingIds((prev) => new Set(prev).add(listing.id));
    setError(listing.id, null);
    const result = await setEnabledAction({ orgSlug, orgListingId: listing.id, enabled });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(listing.id);
      return next;
    });
    if (!result.ok) setError(listing.id, result.error ?? "Update failed");
  };

  const handleUninstall = async (listing: OrgListing) => {
    if (!window.confirm(`Uninstall "${listing.title ?? listing.name}"? This will remove it from all workspaces.`)) return;
    setPendingIds((prev) => new Set(prev).add(listing.id));
    setError(listing.id, null);
    const result = await uninstallAction({ orgSlug, orgListingId: listing.id });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(listing.id);
      return next;
    });
    if (!result.ok) setError(listing.id, result.error ?? "Uninstall failed");
  };

  return (
    <SectionCard
      title="Installed Plugins"
      description="Plugins installed for this organization. Enabled plugins are available to all workspaces."
    >
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {listings.length === 0 ? "No plugins installed." : `${listings.length} plugin${listings.length === 1 ? "" : "s"} installed`}
        </p>
        {canManage && (
          <Button
            variant="outline"
            size="sm"
            onClick={onBrowseMarketplace}
            data-testid="browse-marketplace-btn"
          >
            <ShoppingBag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Browse marketplace
          </Button>
        )}
      </div>

      {listings.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border/40">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/30 text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Plugin</th>
                <th className="px-4 py-2 text-left font-medium">Type</th>
                <th className="px-4 py-2 text-left font-medium">Auth</th>
                <th className="px-4 py-2 text-left font-medium">Enabled</th>
                {canManage && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody>
              {listings.map((listing) => (
                <React.Fragment key={listing.id}>
                  <tr
                    className="border-b border-border/30 last:border-0"
                    data-testid={`org-listing-row-${listing.id}`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {isRenderableImageUrl(listing.iconUrl) ? (
                          <Image
                            src={listing.iconUrl}
                            alt=""
                            width={24}
                            height={24}
                            // Catalog icons are arbitrary remote URLs that can't be
                            // allowlisted in next.config remotePatterns — bypass the
                            // optimizer so the original src renders verbatim.
                            unoptimized
                            className="h-6 w-6 rounded object-contain flex-shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <span className="flex h-6 w-6 items-center justify-center rounded bg-muted flex-shrink-0">
                            {pluginTypeIcon(listing.pluginType)}
                          </span>
                        )}
                        <div>
                          <p className="font-medium" data-testid={`org-listing-display-name-${listing.id}`}>{listing.title ?? listing.name}</p>
                          {listing.title && listing.title !== listing.name && (
                            <p className="text-xs text-muted-foreground">{listing.name}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={pluginTypeBadgeVariant(listing.pluginType)} size="sm">
                        {listing.pluginType.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={authKindBadgeVariant(listing.authKind)} size="sm">
                        {listing.authKind}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Switch
                        checked={listing.enabled}
                        onCheckedChange={(checked) => handleToggle(listing, checked)}
                        disabled={!canManage || pendingIds.has(listing.id)}
                        aria-label={`${listing.enabled ? "Disable" : "Enable"} ${listing.title ?? listing.name}`}
                        data-testid={`org-listing-enable-toggle-${listing.id}`}
                      />
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleUninstall(listing)}
                          disabled={pendingIds.has(listing.id)}
                          className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
                          aria-label={`Uninstall ${listing.title ?? listing.name}`}
                          data-testid={`org-listing-uninstall-btn-${listing.id}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                  {errors[listing.id] && (
                    <tr>
                      <td colSpan={canManage ? 5 : 4} className="px-4 pb-2">
                        <p className="text-xs text-destructive">{errors[listing.id]}</p>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

// ── CustomPluginSection ───────────────────────────────────────────────────────

function CustomPluginSection({
  orgSlug,
  installAction,
}: Pick<OrgPluginsPanelProps, "orgSlug" | "installAction">) {
  const [showForm, setShowForm] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const [name, setName] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [endpointUrl, setEndpointUrl] = React.useState("");
  const [transport, setTransport] = React.useState<"streamable-http" | "sse">("streamable-http");
  const [authKind, setAuthKind] = React.useState<"none" | "secret" | "oauth">("none");

  const handleSubmit = async () => {
    if (!name.trim() || !endpointUrl.trim()) {
      setError("Name and endpoint URL are required.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await installAction({
      orgSlug,
      pluginType: "mcp_server",
      custom: {
        name: name.trim(),
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        endpointUrl: endpointUrl.trim(),
        transport,
        authKind,
      },
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Install failed");
      return;
    }
    setName("");
    setTitle("");
    setDescription("");
    setEndpointUrl("");
    setTransport("streamable-http");
    setAuthKind("none");
    setShowForm(false);
  };

  return (
    <SectionCard
      title="Add Custom Plugin"
      description="Connect a custom MCP server by entering its endpoint URL directly."
    >
      {!showForm ? (
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)} data-testid="add-custom-server-btn">
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Add custom MCP server
        </Button>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="custom-name" className="text-xs">Server name <span className="text-destructive">*</span></Label>
              <Input
                id="custom-name"
                type="text"
                placeholder="my-server"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
                data-testid="custom-server-name-input"
              />
              <p className="text-[10px] text-muted-foreground">Unique identifier, lowercase</p>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="custom-title" className="text-xs">Display title</Label>
              <Input
                id="custom-title"
                type="text"
                placeholder="My Server"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={pending}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-endpoint" className="text-xs">Endpoint URL <span className="text-destructive">*</span></Label>
            <Input
              id="custom-endpoint"
              type="url"
              placeholder="https://my-server.example.com/mcp"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              disabled={pending}
              data-testid="custom-server-endpoint-input"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-description" className="text-xs">Description</Label>
            <Input
              id="custom-description"
              type="text"
              placeholder="What this server does…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={pending}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="custom-transport" className="text-xs">Transport</Label>
              <select
                id="custom-transport"
                className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={transport}
                onChange={(e) => setTransport(e.target.value as "streamable-http" | "sse")}
                disabled={pending}
              >
                <option value="streamable-http">Streamable HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="custom-auth" className="text-xs">Authentication</Label>
              <select
                id="custom-auth"
                className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={authKind}
                onChange={(e) => setAuthKind(e.target.value as "none" | "secret" | "oauth")}
                disabled={pending}
              >
                <option value="none">None</option>
                <option value="secret">API key / secret</option>
                <option value="oauth">OAuth 2.1</option>
              </select>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleSubmit} disabled={pending} data-testid="custom-server-submit-btn">
              {pending ? "Adding…" : "Add plugin"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setShowForm(false); setError(null); }}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ── DenylistSection ───────────────────────────────────────────────────────────

function DenylistSection({
  orgSlug,
  canManage,
  denylisted,
  addDenylistAction,
  removeDenylistAction,
}: Pick<OrgPluginsPanelProps, "orgSlug" | "canManage" | "denylisted" | "addDenylistAction" | "removeDenylistAction">) {
  const [showForm, setShowForm] = React.useState(false);
  const [serverName, setServerName] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [pluginType, setPluginType] = React.useState<"mcp_server" | "integration" | "content_tool" | "capability">("mcp_server");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleAdd = async () => {
    if (!serverName.trim()) {
      setError("Server name is required.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await addDenylistAction({
      orgSlug,
      serverName: serverName.trim(),
      pluginType,
      reason: reason.trim() || undefined,
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Failed to add to denylist");
      return;
    }
    setServerName("");
    setReason("");
    setShowForm(false);
  };

  const handleRemove = async (entry: DenylistEntry) => {
    const result = await removeDenylistAction({
      orgSlug,
      serverName: entry.serverName,
      pluginType: entry.pluginType as "mcp_server" | "integration" | "content_tool" | "capability",
    });
    if (!result.ok) setError(result.error ?? "Remove failed");
  };

  return (
    <SectionCard
      title="Denied Plugins"
      description="Plugins on this list cannot be installed or enabled in any workspace under this organization."
    >
      {denylisted.length > 0 && (
        <div className="mb-4 overflow-hidden rounded-lg border border-border/40">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/40 bg-muted/30 text-xs text-muted-foreground">
                <th className="px-4 py-2 text-left font-medium">Server name</th>
                <th className="px-4 py-2 text-left font-medium">Type</th>
                <th className="px-4 py-2 text-left font-medium">Reason</th>
                {canManage && <th className="px-4 py-2" />}
              </tr>
            </thead>
            <tbody>
              {denylisted.map((entry) => (
                <tr key={entry.id} className="border-b border-border/30 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{entry.serverName}</td>
                  <td className="px-4 py-3">
                    <Badge variant={pluginTypeBadgeVariant(entry.pluginType)} size="sm">
                      {entry.pluginType.replace(/_/g, " ")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground max-w-[200px] truncate">
                    {entry.reason ?? "—"}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleRemove(entry)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        aria-label={`Remove ${entry.serverName} from denylist`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {denylisted.length === 0 && (
        <p className="mb-4 text-xs text-muted-foreground">No plugins have been denied.</p>
      )}

      {canManage && (
        <>
          {!showForm ? (
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)} data-testid="denylist-add-btn">
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Deny a plugin
            </Button>
          ) : (
            <div className="flex flex-col gap-3 rounded-lg border border-border/40 bg-muted/20 p-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="deny-name" className="text-xs">Server name <span className="text-destructive">*</span></Label>
                  <Input
                    id="deny-name"
                    type="text"
                    placeholder="server-name"
                    value={serverName}
                    onChange={(e) => setServerName(e.target.value)}
                    disabled={pending}
                    data-testid="denylist-server-name-input"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="deny-type" className="text-xs">Plugin type</Label>
                  <select
                    id="deny-type"
                    className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={pluginType}
                    onChange={(e) => setPluginType(e.target.value as "mcp_server" | "integration" | "content_tool" | "capability")}
                    disabled={pending}
                  >
                    <option value="mcp_server">MCP Server</option>
                    <option value="integration">Integration</option>
                    <option value="content_tool">Content Tool</option>
                    <option value="capability">Oxagen Plugin</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="deny-reason" className="text-xs">Reason (optional)</Label>
                <Input
                  id="deny-reason"
                  type="text"
                  placeholder="Why this plugin is denied…"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={pending}
                />
              </div>
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={handleAdd} disabled={pending} data-testid="denylist-submit-btn">
                  {pending ? "Adding…" : "Deny plugin"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setShowForm(false); setError(null); }}
                  disabled={pending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ── AuthAlertsSection ─────────────────────────────────────────────────────────

function AuthAlertsSection({
  orgSlug,
  initialSendEmail,
  initialRoles,
  setAuthAlertsAction,
}: {
  orgSlug: string;
  initialSendEmail: boolean;
  initialRoles: string[];
  setAuthAlertsAction: (input: {
    orgSlug: string;
    sendEmail: boolean;
    roles: string[];
  }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const AVAILABLE_ROLES = ["Owner", "Admin"] as const;
  const [sendEmail, setSendEmail] = React.useState(initialSendEmail);
  const [roles, setRoles] = React.useState<string[]>(initialRoles);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const toggleRole = (role: string) =>
    setRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );

  const handleSave = async () => {
    if (roles.length === 0) {
      setError("At least one role must be selected.");
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await setAuthAlertsAction({ orgSlug, sendEmail, roles });
      if (!result.ok) {
        setError(result.error ?? "Save failed");
        return;
      }
      setSaved(true);
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border/60 p-6">
      <h3 className="mb-1 text-sm font-semibold">Re-authentication alerts</h3>
      <p className="mb-4 text-xs text-muted-foreground">
        Notify selected org roles when a plugin&apos;s OAuth token expires and requires re-authentication.
      </p>

      <div className="flex items-center gap-3 mb-4">
        <Switch
          checked={sendEmail}
          onCheckedChange={setSendEmail}
          id={`${orgSlug}-send-email-toggle`}
        />
        <label htmlFor={`${orgSlug}-send-email-toggle`} className="text-sm cursor-pointer">
          Send email notifications
        </label>
      </div>

      <div className="flex flex-col gap-2 mb-4">
        <p className="text-xs font-medium text-muted-foreground">Notify roles</p>
        <div className="flex gap-3">
          {AVAILABLE_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                checked={roles.includes(role)}
                onCheckedChange={() => toggleRole(role)}
              />
              {role}
            </label>
          ))}
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
      {saved && <p className="mb-2 text-xs text-success">Settings saved.</p>}
      <Button size="sm" variant="gradient" onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save alert settings"}
      </Button>
    </div>
  );
}

// ── OrgPluginsPanel ───────────────────────────────────────────────────────────

export function OrgPluginsPanel({
  orgSlug,
  workspaceSlug,
  workspaceId,
  canManage,
  registries,
  listings,
  denylisted,
  initialSendEmail,
  initialAlertRoles,
  setAuthAlertsAction,
  installCatalogAction,
  installAction,
  installBulkAction,
  setEnabledAction,
  uninstallAction,
  addDenylistAction,
  removeDenylistAction,
  addRegistryAction,
  removeRegistryAction,
}: OrgPluginsPanelProps) {
  const [marketplaceOpen, setMarketplaceOpen] = React.useState(false);

  return (
    <div className="flex flex-col gap-6">
      <RegistriesSection
        orgSlug={orgSlug}
        canManage={canManage}
        registries={registries}
        addRegistryAction={addRegistryAction}
        removeRegistryAction={removeRegistryAction}
      />

      <AllowListSection
        orgSlug={orgSlug}
        canManage={canManage}
        listings={listings}
        setEnabledAction={setEnabledAction}
        uninstallAction={uninstallAction}
        onBrowseMarketplace={() => setMarketplaceOpen(true)}
      />

      {canManage && (
        <CustomPluginSection
          orgSlug={orgSlug}
          installAction={installAction}
        />
      )}

      <DenylistSection
        orgSlug={orgSlug}
        canManage={canManage}
        denylisted={denylisted}
        addDenylistAction={addDenylistAction}
        removeDenylistAction={removeDenylistAction}
      />

      {canManage && (
        <AuthAlertsSection
          orgSlug={orgSlug}
          initialSendEmail={initialSendEmail}
          initialRoles={initialAlertRoles}
          setAuthAlertsAction={setAuthAlertsAction}
        />
      )}

      <MarketplaceModal
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        workspaceId={workspaceId}
        open={marketplaceOpen}
        onOpenChange={setMarketplaceOpen}
        deniedNames={denylisted.map((d) => d.serverName)}
        installAction={installCatalogAction}
        installBulkAction={installBulkAction}
      />
    </div>
  );
}
