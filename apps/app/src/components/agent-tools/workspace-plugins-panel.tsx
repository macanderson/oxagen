"use client";
import * as React from "react";
import Image from "next/image";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { MarketplaceModal } from "@/components/plugins/marketplace-modal";
import { CapabilityIcon } from "@/components/plugins/capability-icon";
import { isRenderableImageUrl } from "./plugin-icon";
import { ShoppingBag, Trash2 } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InstalledPlugin {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  iconUrl: string | null;
  pluginType: string;
  authKind: string;
  enabled: boolean;
  wsEnabled: boolean;
}

interface WorkspacePluginsPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  orgId: string;
  workspaceId: string;
  initialPlugins: InstalledPlugin[];
  /**
   * True when the server-side installed-plugins read failed and the list was
   * degraded to empty. Drives an inline notice so an RLS/DB failure doesn't
   * masquerade as "no plugins installed".
   */
  loadError?: boolean;
  installAction: (input: {
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
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  installBulkAction: (input: {
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
  }) => Promise<{ ok: boolean; error?: string }>;
  toggleAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
    enabled: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  uninstallAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Per-type colored icon defaults for the installed-plugins table.
// Matches PLUGIN_TYPE_DEFAULTS in capability-icon.tsx; duplicated here to
// cover types that exist in installed plugins but not in the marketplace tabs
// (e.g. "content_tool", generic "capability").
const INSTALLED_TYPE_ICON: Record<string, { iconName: string; color: string }> =
  {
    mcp_server: { iconName: "plug", color: "#3b82f6" },
    integration: { iconName: "package", color: "#4E6A7A" },
    agent_capability: { iconName: "brain-circuit", color: "#f59e0b" },
    capability: { iconName: "brain-circuit", color: "#f59e0b" },
    agent_skill: { iconName: "sparkles", color: "#10b981" },
    knowledge_source: { iconName: "book-open", color: "#0ea5e9" },
    content_tool: { iconName: "file-text", color: "#64748b" },
  };

function pluginTypeIcon(type: string) {
  const defaults = INSTALLED_TYPE_ICON[type] ?? {
    iconName: "plug",
    color: "#3b82f6",
  };
  return (
    <CapabilityIcon
      iconName={defaults.iconName}
      color={defaults.color}
      size={24}
    />
  );
}

function pluginTypeBadgeVariant(
  type: string,
): "outline" | "muted" | "secondary" | "info" {
  if (type === "integration") return "muted";
  if (type === "content_tool") return "secondary";
  if (type === "capability" || type === "agent_capability") return "info";
  return "outline";
}

// ── WorkspacePluginsPanel ─────────────────────────────────────────────────────

export function WorkspacePluginsPanel({
  orgSlug,
  workspaceSlug,
  // orgId is part of the props contract but unused in this panel; not
  // destructured to satisfy no-unused-vars while keeping the prop accepted.
  workspaceId,
  initialPlugins,
  loadError = false,
  installAction,
  installBulkAction,
  toggleAction,
  uninstallAction,
}: WorkspacePluginsPanelProps) {
  const [plugins, setPlugins] = React.useState(initialPlugins);
  const [marketplaceOpen, setMarketplaceOpen] = React.useState(false);
  const [pendingIds, setPendingIds] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Re-fetch installed plugins from the API (called after marketplace install).
  const refreshPlugins = React.useCallback(async () => {
    try {
      const params = new URLSearchParams({ workspaceId });
      const res = await fetch(`/api/v1/plugin/org/list?${params.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        listings: Array<{
          id: string;
          name: string;
          title: string | null;
          description: string | null;
          iconUrl: string | null;
          pluginType: string;
          authKind: string;
          enabled: boolean;
        }>;
      };
      setPlugins(
        data.listings.map((row) => ({
          id: row.id,
          name: row.name,
          title: row.title,
          description: row.description,
          iconUrl: row.iconUrl,
          pluginType: row.pluginType,
          authKind: row.authKind,
          enabled: row.enabled,
          wsEnabled: row.enabled,
        })),
      );
    } catch {
      // Non-fatal: the list will refresh on next page load.
    }
  }, [workspaceId]);

  // When the marketplace modal closes, refresh the plugin list to show new installs.
  const handleMarketplaceOpenChange = React.useCallback(
    (open: boolean) => {
      setMarketplaceOpen(open);
      if (!open) {
        // Modal just closed — refresh to pick up any new installs.
        void refreshPlugins();
      }
    },
    [refreshPlugins],
  );

  const setError = (id: string, msg: string | null) =>
    setErrors((prev) => {
      const next = { ...prev };
      if (msg === null) delete next[id];
      else next[id] = msg;
      return next;
    });

  const handleToggle = async (plugin: InstalledPlugin, enabled: boolean) => {
    setPendingIds((prev) => new Set(prev).add(plugin.id));
    setError(plugin.id, null);
    // Optimistic update
    setPlugins((prev) =>
      prev.map((p) =>
        p.id === plugin.id ? { ...p, wsEnabled: enabled, enabled } : p,
      ),
    );
    const result = await toggleAction({
      orgSlug,
      workspaceSlug,
      orgListingId: plugin.id,
      enabled,
    });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(plugin.id);
      return next;
    });
    if (!result.ok) {
      // Revert
      setPlugins((prev) =>
        prev.map((p) =>
          p.id === plugin.id
            ? { ...p, wsEnabled: !enabled, enabled: !enabled }
            : p,
        ),
      );
      setError(plugin.id, result.error ?? "Update failed");
    }
  };

  const handleUninstall = async (plugin: InstalledPlugin) => {
    if (
      !window.confirm(
        `Remove "${plugin.title ?? plugin.name}" from this workspace?`,
      )
    )
      return;
    setPendingIds((prev) => new Set(prev).add(plugin.id));
    setError(plugin.id, null);
    const result = await uninstallAction({
      orgSlug,
      workspaceSlug,
      orgListingId: plugin.id,
    });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(plugin.id);
      return next;
    });
    if (!result.ok) {
      setError(plugin.id, result.error ?? "Uninstall failed");
    } else {
      setPlugins((prev) => prev.filter((p) => p.id !== plugin.id));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {loadError && (
        <Alert variant="error">
          <AlertTitle>Couldn&apos;t load installed plugins</AlertTitle>
          <AlertDescription>
            We hit an error reading this workspace&apos;s plugins, so the list
            below may be incomplete. Reload the page to try again — your plugins
            have not been removed.
          </AlertDescription>
        </Alert>
      )}

      {/* Installed plugins section — registry administration lives in
          Settings → MCP Server Registries, not here. */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Installed Plugins
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Plugins enabled for this workspace.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMarketplaceOpen(true)}
            data-testid="ws-browse-marketplace-btn"
          >
            <ShoppingBag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Browse Marketplace
          </Button>
        </div>

        {plugins.length === 0 ? (
          <div className="rounded-lg border border-border/40 bg-muted/20 px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              No plugins installed. Browse the marketplace to add MCP servers,
              integrations, and capabilities to this workspace.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setMarketplaceOpen(true)}
              data-testid="ws-browse-marketplace-empty-btn"
            >
              <ShoppingBag className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Browse Marketplace
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border/30 overflow-hidden rounded-lg border border-border/40">
            {plugins.map((plugin) => (
              <li
                key={plugin.id}
                className="flex flex-col gap-2 px-4 py-3"
                data-testid={`ws-plugin-row-${plugin.id}`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {(() => {
                      const iconUrl = plugin.iconUrl;
                      if (!iconUrl) {
                        return (
                          <span className="flex h-6 w-6 items-center justify-center rounded bg-muted flex-shrink-0">
                            {pluginTypeIcon(plugin.pluginType)}
                          </span>
                        );
                      }
                      if (iconUrl.startsWith("lucide:")) {
                        const parts = iconUrl.split(":");
                        const iconName = parts[1] ?? "brain-circuit";
                        const color =
                          parts[2] ||
                          INSTALLED_TYPE_ICON[plugin.pluginType]?.color ||
                          "#6b7280";
                        return (
                          <span className="flex h-6 w-6 items-center justify-center rounded flex-shrink-0">
                            <CapabilityIcon
                              iconName={iconName}
                              color={color}
                              size={24}
                            />
                          </span>
                        );
                      }
                      if (isRenderableImageUrl(iconUrl)) {
                        return (
                          <Image
                            src={iconUrl}
                            alt=""
                            width={24}
                            height={24}
                            unoptimized
                            className="h-6 w-6 rounded object-contain flex-shrink-0"
                            aria-hidden="true"
                          />
                        );
                      }
                      return (
                        <span className="flex h-6 w-6 items-center justify-center rounded bg-muted flex-shrink-0">
                          {pluginTypeIcon(plugin.pluginType)}
                        </span>
                      );
                    })()}
                    <div className="min-w-0">
                      <p
                        className="font-medium"
                        data-testid={`ws-plugin-name-${plugin.id}`}
                      >
                        {plugin.title ?? plugin.name}
                      </p>
                      {plugin.title && plugin.title !== plugin.name && (
                        <p className="text-xs text-muted-foreground">
                          {plugin.name}
                        </p>
                      )}
                      {plugin.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                          {plugin.description}
                        </p>
                      )}
                    </div>
                  </div>

                  <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <div>
                      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Type
                      </dt>
                      <dd className="mt-0.5 text-sm">
                        <Badge
                          variant={pluginTypeBadgeVariant(plugin.pluginType)}
                          size="sm"
                        >
                          {plugin.pluginType.replace(/_/g, " ")}
                        </Badge>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        Enabled
                      </dt>
                      <dd className="mt-0.5 text-sm">
                        <Switch
                          checked={plugin.wsEnabled}
                          onCheckedChange={(checked) =>
                            handleToggle(plugin, checked)
                          }
                          disabled={pendingIds.has(plugin.id)}
                          aria-label={`${plugin.wsEnabled ? "Disable" : "Enable"} ${plugin.title ?? plugin.name}`}
                          data-testid={`ws-plugin-toggle-${plugin.id}`}
                        />
                      </dd>
                    </div>
                  </dl>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleUninstall(plugin)}
                      disabled={pendingIds.has(plugin.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
                      aria-label={`Remove ${plugin.title ?? plugin.name} from workspace`}
                      data-testid={`ws-plugin-remove-btn-${plugin.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {errors[plugin.id] && (
                  <p className="text-xs text-destructive">
                    {errors[plugin.id]}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <MarketplaceModal
        open={marketplaceOpen}
        onOpenChange={handleMarketplaceOpenChange}
        installAction={(input) =>
          installAction({ ...input, workspaceSlug, workspaceId })
        }
        installBulkAction={(input) =>
          installBulkAction({ ...input, workspaceSlug, workspaceId })
        }
      />
    </div>
  );
}
