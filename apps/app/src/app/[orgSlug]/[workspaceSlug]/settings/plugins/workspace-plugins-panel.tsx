"use client";
import * as React from "react";
import Image from "next/image";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarketplaceModal } from "@/components/plugins/marketplace-modal";
import { isRenderableImageUrl } from "@/lib/plugin-icon";
import { RegistryManager, type RegistryRow } from "./registry-manager";
import { ShoppingBag, Trash2, Plug, Package, FileText, Boxes } from "lucide-react";

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
  initialRegistries: RegistryRow[];
  docsBaseUrl: string;
  installAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    workspaceId: string;
    catalogServerId: string;
    pluginType: "mcp_server" | "integration" | "content_tool" | "capability" | "agent_skill" | "agent_capability" | "knowledge_source";
    pluginId?: string;
  }) => Promise<{ ok: boolean; orgListingId?: string; error?: string }>;
  installBulkAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    workspaceId: string;
    items: Array<{
      catalogServerId?: string;
      pluginType: "mcp_server" | "integration" | "content_tool" | "capability" | "agent_skill" | "agent_capability" | "knowledge_source";
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
  addRegistryAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    name: string;
    baseUrl: string;
  }) => Promise<{ ok: boolean; registryId?: string; isDefault?: boolean; error?: string }>;
  removeRegistryAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    registryId: string;
  }) => Promise<{ ok: boolean; promotedId?: string | null; error?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pluginTypeIcon(type: string) {
  if (type === "integration") return <Package className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  if (type === "content_tool") return <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  if (type === "capability" || type === "agent_capability") return <Boxes className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  return <Plug className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
}

function pluginTypeBadgeVariant(type: string): "outline" | "muted" | "secondary" | "info" {
  if (type === "integration") return "muted";
  if (type === "content_tool") return "secondary";
  if (type === "capability" || type === "agent_capability") return "info";
  return "outline";
}

// ── WorkspacePluginsPanel ─────────────────────────────────────────────────────

export function WorkspacePluginsPanel({
  orgSlug,
  workspaceSlug,
  orgId,
  workspaceId,
  initialPlugins,
  initialRegistries,
  docsBaseUrl,
  installAction,
  installBulkAction,
  toggleAction,
  uninstallAction,
  addRegistryAction,
  removeRegistryAction,
}: WorkspacePluginsPanelProps) {
  const [plugins, setPlugins] = React.useState(initialPlugins);
  const [marketplaceOpen, setMarketplaceOpen] = React.useState(false);
  const [pendingIds, setPendingIds] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Record<string, string>>({});

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
      prev.map((p) => (p.id === plugin.id ? { ...p, wsEnabled: enabled, enabled } : p)),
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
          p.id === plugin.id ? { ...p, wsEnabled: !enabled, enabled: !enabled } : p,
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
      {/* Registry manager */}
      <RegistryManager
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        initialRegistries={initialRegistries}
        docsBaseUrl={docsBaseUrl}
        addRegistryAction={addRegistryAction}
        removeRegistryAction={removeRegistryAction}
      />

      {/* Installed plugins section */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Installed Plugins</h3>
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
              No plugins installed. Browse the marketplace to add MCP servers, integrations, and
              capabilities to this workspace.
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
          <div className="overflow-hidden rounded-lg border border-border/40">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/40 text-xs">
                  <th className="px-4 py-2 text-left font-medium">Plugin</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-left font-medium">Enabled</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {plugins.map((plugin) => (
                  <React.Fragment key={plugin.id}>
                    <tr
                      className="border-b border-border/30 last:border-0"
                      data-testid={`ws-plugin-row-${plugin.id}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {isRenderableImageUrl(plugin.iconUrl) ? (
                            <Image
                              src={plugin.iconUrl!}
                              alt=""
                              width={24}
                              height={24}
                              unoptimized
                              className="h-6 w-6 rounded object-contain flex-shrink-0"
                              aria-hidden="true"
                            />
                          ) : (
                            <span className="flex h-6 w-6 items-center justify-center rounded bg-muted flex-shrink-0">
                              {pluginTypeIcon(plugin.pluginType)}
                            </span>
                          )}
                          <div>
                            <p
                              className="font-medium"
                              data-testid={`ws-plugin-name-${plugin.id}`}
                            >
                              {plugin.title ?? plugin.name}
                            </p>
                            {plugin.title && plugin.title !== plugin.name && (
                              <p className="text-xs text-muted-foreground">{plugin.name}</p>
                            )}
                            {plugin.description && (
                              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                                {plugin.description}
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={pluginTypeBadgeVariant(plugin.pluginType)} size="sm">
                          {plugin.pluginType.replace(/_/g, " ")}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <Switch
                          checked={plugin.wsEnabled}
                          onCheckedChange={(checked) => handleToggle(plugin, checked)}
                          disabled={pendingIds.has(plugin.id)}
                          aria-label={`${plugin.wsEnabled ? "Disable" : "Enable"} ${plugin.title ?? plugin.name}`}
                          data-testid={`ws-plugin-toggle-${plugin.id}`}
                        />
                      </td>
                      <td className="px-4 py-3 text-right">
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
                      </td>
                    </tr>
                    {errors[plugin.id] && (
                      <tr>
                        <td colSpan={4} className="px-4 pb-2">
                          <p className="text-xs text-destructive">{errors[plugin.id]}</p>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <MarketplaceModal
        open={marketplaceOpen}
        onOpenChange={setMarketplaceOpen}
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
