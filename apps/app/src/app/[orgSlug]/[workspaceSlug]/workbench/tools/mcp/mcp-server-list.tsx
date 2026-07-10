"use client";
/**
 * mcp-server-list.tsx — installed mcp_server plugins for this workspace.
 *
 * Toggle/uninstall reuse the plugin-type-agnostic togglePlugin/uninstallPlugin
 * server actions from settings/plugins/plugin-actions.ts — no duplicated
 * enable/disable or delete logic. OAuth listings additionally surface their
 * credential status (from mcp.credentials) with an Authenticate /
 * Re-authenticate action into the OAuth authorize route — an installed OAuth
 * server does nothing until that flow completes — plus a "Remove auth"
 * action (revoke_plugin_credential) that deletes the stored credential so
 * the server must be re-authenticated before it can be used again.
 */
import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { CapabilityIcon } from "@/components/plugins/capability-icon";
import { KeyRound, ShieldOff, Trash2 } from "lucide-react";
import { mcpAuthorizeUrl } from "@/lib/mcp-oauth/authorize-url";

export interface McpServerRow {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  endpointUrl: string | null;
  transport: string | null;
  authKind: string;
  enabled: boolean;
  /** mcp.credentials status for this listing, or null when no credential exists. */
  credentialStatus: "active" | "needs_reauth" | "revoked" | null;
}

export interface ConnectionDisplay {
  label: string;
  variant: "success" | "warning" | "error" | "muted";
  /** Text for the auth action button, or null when no action applies. */
  action: "Authenticate" | "Re-authenticate" | null;
}

/**
 * Pure status → display mapping, exported for unit tests. OAuth servers are
 * the only kind whose connection state is driven by mcp.credentials; secret
 * servers show Connected once a secret is stored; "none" needs nothing.
 */
export function connectionDisplay(
  authKind: string,
  credentialStatus: McpServerRow["credentialStatus"],
): ConnectionDisplay {
  if (authKind === "oauth") {
    if (credentialStatus === "active") {
      return { label: "Connected", variant: "success", action: "Re-authenticate" };
    }
    if (credentialStatus === "needs_reauth") {
      return { label: "Needs re-auth", variant: "error", action: "Re-authenticate" };
    }
    if (credentialStatus === "revoked") {
      return { label: "Revoked", variant: "error", action: "Authenticate" };
    }
    return { label: "Needs authentication", variant: "warning", action: "Authenticate" };
  }
  if (authKind === "secret") {
    return credentialStatus === "active"
      ? { label: "Connected", variant: "success", action: null }
      : { label: "Secret required", variant: "muted", action: null };
  }
  return { label: "No auth needed", variant: "muted", action: null };
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
  revokeAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
  }) => Promise<{ ok: boolean; revoked?: boolean; error?: string }>;
}

export function McpServerList({
  orgSlug,
  workspaceSlug,
  initialServers,
  toggleAction,
  uninstallAction,
  revokeAction,
}: McpServerListProps) {
  const [servers, setServers] = React.useState(initialServers);
  // The parent server component re-queries and passes fresh `initialServers`
  // after a server is connected (or removed) via the form above, which calls
  // router.refresh(). useState only seeds on mount, so without this resync a
  // newly-connected server never appears in the list until a full navigation.
  React.useEffect(() => {
    setServers(initialServers);
  }, [initialServers]);
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

  const handleRevoke = async (server: McpServerRow) => {
    if (
      !window.confirm(
        `Remove authentication for "${server.title ?? server.name}"? The server stays installed but can't be used until you authenticate again.`,
      )
    )
      return;
    setPendingIds((prev) => new Set(prev).add(server.id));
    setError(server.id, null);
    const result = await revokeAction({ orgSlug, workspaceSlug, orgListingId: server.id });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(server.id);
      return next;
    });
    if (!result.ok) {
      setError(server.id, result.error ?? "Remove authentication failed");
    } else {
      setServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, credentialStatus: null } : s)),
      );
    }
  };

  if (servers.length === 0) {
    return (
      <EmptyState
        size="sm"
        variant="muted"
        title="No MCP servers installed yet"
        description="Install one from the marketplace below, or connect a custom endpoint manually."
      />
    );
  }

  // Card list (not a table): a workspace connects a handful of servers, and
  // each row carries interactive controls (toggle, auth, remove) that read
  // better as a card on every screen size.
  return (
    <ul className="divide-y divide-border/30 overflow-hidden rounded-lg border border-border/40">
      {servers.map((server) => {
        const display = connectionDisplay(server.authKind, server.credentialStatus);
        return (
          <li
            key={server.id}
            className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-6"
            data-testid={`mcp-server-row-${server.id}`}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded bg-muted flex-shrink-0">
                <CapabilityIcon iconName="plug" color="#3b82f6" size={24} />
              </span>
              <div className="min-w-0">
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
            <dl className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="min-w-0">
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Endpoint
                </dt>
                <dd className="mt-0.5 max-w-[240px] truncate text-xs text-muted-foreground">
                  {server.endpointUrl || "—"}
                  {server.transport && (
                    <Badge variant="outline" size="sm" className="ml-2">
                      {server.transport}
                    </Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Auth
                </dt>
                <dd className="mt-0.5">
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
                </dd>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
              <Badge
                variant={display.variant}
                size="sm"
                data-testid={`mcp-server-status-${server.id}`}
              >
                {display.label}
              </Badge>
              {display.action ? (
                <Button
                  size="sm"
                  variant={display.action === "Authenticate" ? "default" : "ghost"}
                  render={
                    <a
                      href={mcpAuthorizeUrl({
                        orgSlug,
                        workspaceSlug,
                        orgListingId: server.id,
                        returnTo: `/${orgSlug}/${workspaceSlug}/workbench/tools/mcp`,
                      })}
                      data-testid={`mcp-server-authenticate-${server.id}`}
                    />
                  }
                >
                  <KeyRound className="h-3 w-3" aria-hidden="true" />
                  {display.action}
                </Button>
              ) : null}
              {/* Remove auth — only meaningful while a credential row exists.
                  Keeps the install; deletes the stored credential. */}
              {server.credentialStatus !== null ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleRevoke(server)}
                  disabled={pendingIds.has(server.id)}
                  data-testid={`mcp-server-revoke-${server.id}`}
                >
                  <ShieldOff className="h-3 w-3" aria-hidden="true" />
                  Remove auth
                </Button>
              ) : null}
              <span className="ml-auto max-w-[50%] truncate">
                {server.endpointUrl || "—"}
                {server.transport && (
                  <Badge variant="outline" size="sm" className="ml-2">
                    {server.transport}
                  </Badge>
                  {display.action ? (
                    <Button
                      size="sm"
                      variant={display.action === "Authenticate" ? "default" : "ghost"}
                      render={
                        <a
                          href={mcpAuthorizeUrl({
                            orgSlug,
                            workspaceSlug,
                            orgListingId: server.id,
                            returnTo: `/${orgSlug}/${workspaceSlug}/workbench/tools/mcp`,
                          })}
                          data-testid={`mcp-server-authenticate-${server.id}`}
                        />
                      }
                    >
                      <KeyRound className="h-3 w-3" aria-hidden="true" />
                      {display.action}
                    </Button>
                  ) : null}
                  {/* Remove auth — only meaningful while a credential row
                      exists. Keeps the install; deletes the stored credential. */}
                  {server.credentialStatus !== null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRevoke(server)}
                      disabled={pendingIds.has(server.id)}
                      data-testid={`mcp-server-revoke-${server.id}`}
                    >
                      <ShieldOff className="h-3 w-3" aria-hidden="true" />
                      Remove auth
                    </Button>
                  ) : null}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Enabled
                </dt>
                <dd className="mt-0.5">
                  <Switch
                    checked={server.enabled}
                    onCheckedChange={(checked) => handleToggle(server, checked)}
                    disabled={pendingIds.has(server.id)}
                    aria-label={`${server.enabled ? "Disable" : "Enable"} ${server.title ?? server.name}`}
                    data-testid={`mcp-server-toggle-${server.id}`}
                  />
                </dd>
              </div>
            </dl>
            <div className="flex shrink-0 items-center gap-1 sm:ml-auto">
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
            </div>
            {errors[server.id] && (
              <p className="text-xs text-destructive sm:basis-full">
                {errors[server.id]}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
