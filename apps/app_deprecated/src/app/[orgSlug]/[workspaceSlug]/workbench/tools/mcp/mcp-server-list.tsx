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
import { SecretDialog } from "./secret-dialog";

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
  /**
   * The auth action offered for this row, or null when none applies.
   * "Authenticate"/"Re-authenticate" navigate to the OAuth authorize route;
   * "Enter API key"/"Update API key" open the secret-entry dialog. The caller
   * renders OAuth actions as links and secret actions as dialog triggers.
   */
  action:
    | "Authenticate"
    | "Re-authenticate"
    | "Enter API key"
    | "Update API key"
    | null;
}

/**
 * Pure status → display mapping, exported for unit tests. OAuth and secret
 * servers both drive their connection state from mcp.credentials; "none" needs
 * nothing. A secret server without a stored key is unusable until the key is
 * entered — so it offers an "Enter API key" action (the OAuth-consent
 * counterpart for API-key servers like Stripe).
 */
export function connectionDisplay(
  authKind: string,
  credentialStatus: McpServerRow["credentialStatus"],
): ConnectionDisplay {
  if (authKind === "oauth") {
    if (credentialStatus === "active") {
      return {
        label: "Connected",
        variant: "success",
        action: "Re-authenticate",
      };
    }
    if (credentialStatus === "needs_reauth") {
      return {
        label: "Needs re-auth",
        variant: "error",
        action: "Re-authenticate",
      };
    }
    if (credentialStatus === "revoked") {
      return { label: "Revoked", variant: "error", action: "Authenticate" };
    }
    return {
      label: "Needs authentication",
      variant: "warning",
      action: "Authenticate",
    };
  }
  if (authKind === "secret") {
    return credentialStatus === "active"
      ? { label: "Connected", variant: "success", action: "Update API key" }
      : {
          label: "Secret required",
          variant: "warning",
          action: "Enter API key",
        };
  }
  return { label: "No auth needed", variant: "muted", action: null };
}

/** True for the two secret-entry actions (rendered as a dialog trigger). */
function isSecretAction(
  action: ConnectionDisplay["action"],
): action is "Enter API key" | "Update API key" {
  return action === "Enter API key" || action === "Update API key";
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
  /** Stores an API key / static secret for a secret-auth server. */
  saveSecretAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
    secret: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  /**
   * orgListingId from the ?reauth= deep link (the "needs re-auth" notification).
   * When set and present in the list, that row is scrolled into view and
   * briefly highlighted so the user lands directly on its Re-authenticate action.
   */
  reauthListingId?: string | null;
}

export function McpServerList({
  orgSlug,
  workspaceSlug,
  initialServers,
  toggleAction,
  uninstallAction,
  revokeAction,
  saveSecretAction,
  reauthListingId,
}: McpServerListProps) {
  const [servers, setServers] = React.useState(initialServers);
  // The secret-auth server whose "Enter/Update API key" dialog is open, or null.
  const [secretDialogFor, setSecretDialogFor] =
    React.useState<McpServerRow | null>(null);
  // The parent server component re-queries and passes fresh `initialServers`
  // after a server is connected (or removed) via the form above, which calls
  // router.refresh(). useState only seeds on mount, so without this resync a
  // newly-connected server never appears in the list until a full navigation.
  React.useEffect(() => {
    setServers(initialServers);
  }, [initialServers]);
  const [pendingIds, setPendingIds] = React.useState<Set<string>>(new Set());
  const [errors, setErrors] = React.useState<Record<string, string>>({});

  // Deep-link landing: scroll the reauth-target row into view and highlight it
  // briefly. Only fires when the id actually matches an installed row, so a
  // stale link (server since uninstalled) degrades to a normal page view.
  const [highlightId, setHighlightId] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!reauthListingId) return;
    if (!servers.some((s) => s.id === reauthListingId)) return;
    setHighlightId(reauthListingId);
    const el = document.querySelector(
      `[data-testid="mcp-server-row-${reauthListingId}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    // Fade the highlight after a few seconds so it reads as a one-time cue.
    const t = setTimeout(() => setHighlightId(null), 4000);
    return () => clearTimeout(t);
  }, [reauthListingId, servers]);

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
    setServers((prev) =>
      prev.map((s) => (s.id === server.id ? { ...s, enabled } : s)),
    );
    const result = await toggleAction({
      orgSlug,
      workspaceSlug,
      orgListingId: server.id,
      enabled,
    });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(server.id);
      return next;
    });
    if (!result.ok) {
      setServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, enabled: !enabled } : s)),
      );
      setError(server.id, result.error ?? "Update failed");
    }
  };

  const handleUninstall = async (server: McpServerRow) => {
    if (
      !window.confirm(
        `Remove "${server.title ?? server.name}" from this workspace?`,
      )
    )
      return;
    setPendingIds((prev) => new Set(prev).add(server.id));
    setError(server.id, null);
    const result = await uninstallAction({
      orgSlug,
      workspaceSlug,
      orgListingId: server.id,
    });
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
    const result = await revokeAction({
      orgSlug,
      workspaceSlug,
      orgListingId: server.id,
    });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(server.id);
      return next;
    });
    if (!result.ok) {
      setError(server.id, result.error ?? "Remove authentication failed");
    } else {
      setServers((prev) =>
        prev.map((s) =>
          s.id === server.id ? { ...s, credentialStatus: null } : s,
        ),
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
    <>
      <ul className="divide-y divide-border/30 overflow-hidden rounded-lg border border-border/40">
        {servers.map((server) => {
          const display = connectionDisplay(
            server.authKind,
            server.credentialStatus,
          );
          return (
            <li
              key={server.id}
              className={`flex flex-col gap-3 px-4 py-3 transition-colors sm:flex-row sm:items-center sm:gap-6 ${
                highlightId === server.id
                  ? "bg-warning/12 ring-1 ring-inset ring-warning/40"
                  : ""
              }`}
              data-testid={`mcp-server-row-${server.id}`}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded bg-muted flex-shrink-0">
                  <CapabilityIcon iconName="plug" color="#3b82f6" size={24} />
                </span>
                <div className="min-w-0">
                  <p
                    className="font-medium"
                    data-testid={`mcp-server-name-${server.id}`}
                  >
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
                <div>
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Status
                  </dt>
                  <dd className="mt-0.5 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={display.variant}
                      size="sm"
                      data-testid={`mcp-server-status-${server.id}`}
                    >
                      {display.label}
                    </Badge>
                    {isSecretAction(display.action) ? (
                      // Secret-auth: open the API-key entry dialog (no redirect).
                      <Button
                        size="sm"
                        variant={
                          display.action === "Enter API key"
                            ? "default"
                            : "ghost"
                        }
                        onClick={() => setSecretDialogFor(server)}
                        disabled={pendingIds.has(server.id)}
                        data-testid={`mcp-server-set-secret-${server.id}`}
                      >
                        <KeyRound className="h-3 w-3" aria-hidden="true" />
                        {display.action}
                      </Button>
                    ) : display.action ? (
                      // OAuth: full-page navigation into the authorize route.
                      <Button
                        size="sm"
                        variant={
                          display.action === "Authenticate"
                            ? "default"
                            : "ghost"
                        }
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
                      onCheckedChange={(checked) =>
                        handleToggle(server, checked)
                      }
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
      {secretDialogFor ? (
        <SecretDialog
          open
          onOpenChange={(open) => {
            if (!open) setSecretDialogFor(null);
          }}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          orgListingId={secretDialogFor.id}
          serverTitle={secretDialogFor.title ?? secretDialogFor.name}
          saveAction={saveSecretAction}
          onSaved={() => {
            // The stored key flips the row to Connected without a full reload.
            const savedId = secretDialogFor.id;
            setServers((prev) =>
              prev.map((s) =>
                s.id === savedId ? { ...s, credentialStatus: "active" } : s,
              ),
            );
            setSecretDialogFor(null);
          }}
        />
      ) : null}
    </>
  );
}
