"use client";
/**
 * mcp-server-list.tsx — installed mcp_server plugins for this workspace.
 *
 * Toggle/uninstall reuse the plugin-type-agnostic togglePlugin/uninstallPlugin
 * server actions from settings/plugins/plugin-actions.ts — no duplicated
 * enable/disable or delete logic.
 */
import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { CapabilityIcon } from "@/components/plugins/capability-icon";
import { Trash2 } from "lucide-react";

export interface McpServerRow {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  endpointUrl: string | null;
  transport: string | null;
  authKind: string;
  enabled: boolean;
}

interface McpServerListProps {
  orgSlug: string;
  workspaceSlug: string;
  initialServers: McpServerRow[];
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

export function McpServerList({
  orgSlug,
  workspaceSlug,
  initialServers,
  toggleAction,
  uninstallAction,
}: McpServerListProps) {
  const [servers, setServers] = React.useState(initialServers);
  const [pendingIds, setPendingIds] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  const setError = (id: string, msg: string | null) =>
    setErrors((prev) => {
      const next = { ...prev };
      if (msg === null) delete next[id];
      else next[id] = msg;
      return next;
    });

  const handleToggle = async (server: McpServerRow, enabled: boolean) => {
    setPendingIds((prev) => new Set(prev).add(server.id));
    setError(server.id, null);
    setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled } : s)));
    const result = await toggleAction({ orgSlug, workspaceSlug, orgListingId: server.id, enabled });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(server.id);
      return next;
    });
    if (!result.ok) {
      setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, enabled: !enabled } : s)));
      setError(server.id, result.error ?? "Update failed");
    }
  };

  const handleUninstall = async (server: McpServerRow) => {
    if (!window.confirm(`Remove "${server.title ?? server.name}" from this workspace?`)) return;
    setPendingIds((prev) => new Set(prev).add(server.id));
    setError(server.id, null);
    const result = await uninstallAction({ orgSlug, workspaceSlug, orgListingId: server.id });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(server.id);
      return next;
    });
    if (!result.ok) {
      setError(server.id, result.error ?? "Uninstall failed");
    } else {
      setServers((prev) => prev.filter((s) => s.id !== server.id));
    }
  };

  if (servers.length === 0) {
    return (
      <div className="rounded-lg border border-border/40 bg-muted/20 px-6 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          No MCP servers connected yet. Use the form above to connect one.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border/40">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/40 text-xs">
            <th className="px-4 py-2 text-left font-medium">Server</th>
            <th className="px-4 py-2 text-left font-medium">Endpoint</th>
            <th className="px-4 py-2 text-left font-medium">Auth</th>
            <th className="px-4 py-2 text-left font-medium">Enabled</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => (
            <React.Fragment key={server.id}>
              <tr className="border-b border-border/30 last:border-0" data-testid={`mcp-server-row-${server.id}`}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded bg-muted flex-shrink-0">
                      <CapabilityIcon iconName="plug" color="#3b82f6" size={24} />
                    </span>
                    <div>
                      <p className="font-medium" data-testid={`mcp-server-name-${server.id}`}>
                        {server.title ?? server.name}
                      </p>
                      {server.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                          {server.description}
                        </p>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 max-w-[240px] truncate text-xs text-muted-foreground">
                  {server.endpointUrl || "—"}
                  {server.transport && (
                    <Badge variant="outline" size="sm" className="ml-2">
                      {server.transport}
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge
                    variant={
                      server.authKind === "oauth"
                        ? "info"
                        : server.authKind === "secret"
                          ? "warning"
                          : "muted"
                    }
                    size="sm"
                  >
                    {server.authKind}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  <Switch
                    checked={server.enabled}
                    onCheckedChange={(checked) => handleToggle(server, checked)}
                    disabled={pendingIds.has(server.id)}
                    aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.title ?? server.name}`}
                    data-testid={`mcp-server-toggle-${server.id}`}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => handleUninstall(server)}
                    disabled={pendingIds.has(server.id)}
                    className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
                    aria-label={`Remove ${server.title ?? server.name} from workspace`}
                    data-testid={`mcp-server-remove-btn-${server.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
              {errors[server.id] && (
                <tr>
                  <td colSpan={5} className="px-4 pb-2">
                    <p className="text-xs text-destructive">{errors[server.id]}</p>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
