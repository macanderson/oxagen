"use client";
import * as React from "react";
import Image from "next/image";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plug, CheckCircle2, AlertCircle, Circle, ExternalLink } from "lucide-react";
import { org } from "@/lib/routes";
import Link from "next/link";
import type { schema } from "@oxagen/database";

// ── Types ─────────────────────────────────────────────────────────────────────

type OrgListing = typeof schema.pluginOrgListings.$inferSelect;
type McpServer = typeof schema.mcpServers.$inferSelect;

interface WorkspaceIntegrationsPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
  orgListings: OrgListing[];
  /** orgListingId → workspace install row */
  wsInstallMap: Record<string, McpServer>;
  setEnabledAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
    enabled: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  setSecretAction: (input: {
    orgSlug: string;
    workspaceSlug: string;
    orgListingId: string;
    secret: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function HealthIcon({ status }: { status: string | null | undefined }) {
  if (status === "healthy") {
    return (
      <CheckCircle2
        className="h-3.5 w-3.5 text-success"
        aria-label="Healthy"
      />
    );
  }
  if (status === "error" || status === "degraded") {
    return (
      <AlertCircle
        className="h-3.5 w-3.5 text-destructive"
        aria-label="Error"
      />
    );
  }
  return (
    <Circle
      className="h-3.5 w-3.5 text-muted-foreground/40"
      aria-label="Not configured"
    />
  );
}

function pluginTypeBadgeVariant(type: string): "outline" | "muted" | "secondary" {
  if (type === "integration") return "muted";
  if (type === "content_tool") return "secondary";
  return "outline";
}

function authKindBadgeVariant(kind: string): "info" | "warning" | "muted" {
  if (kind === "oauth") return "info";
  if (kind === "secret") return "warning";
  return "muted";
}

// ── SecretForm (inline per-row) ───────────────────────────────────────────────

function SecretForm({
  orgSlug,
  workspaceSlug,
  orgListingId,
  setSecretAction,
}: {
  orgSlug: string;
  workspaceSlug: string;
  orgListingId: string;
  setSecretAction: WorkspaceIntegrationsPanelProps["setSecretAction"];
}) {
  const [open, setOpen] = React.useState(false);
  const [secret, setSecret] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const handleSave = async () => {
    if (!secret.trim()) {
      setError("Secret is required.");
      return;
    }
    setPending(true);
    setError(null);
    setSaved(false);
    const result = await setSecretAction({
      orgSlug,
      workspaceSlug,
      orgListingId,
      secret: secret.trim(),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? "Failed to save secret");
      return;
    }
    setSaved(true);
    setSecret("");
    setOpen(false);
  };

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid={`integrations-set-secret-btn-${orgListingId}`}
      >
        Set API key
      </Button>
    );
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-lg border border-border/40 bg-muted/20 p-3"
      data-testid={`integrations-secret-form-${orgListingId}`}
    >
      <Input
        type="password"
        placeholder="Paste your API key or secret…"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        disabled={pending}
        autoComplete="off"
        data-testid={`integrations-secret-input-${orgListingId}`}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      {saved && <p className="text-xs text-success">Saved.</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ── WorkspaceIntegrationsPanel ────────────────────────────────────────────────

export function WorkspaceIntegrationsPanel({
  orgSlug,
  workspaceSlug,
  canManage,
  orgListings,
  wsInstallMap,
  setEnabledAction,
  setSecretAction,
}: WorkspaceIntegrationsPanelProps) {
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
    const result = await setEnabledAction({
      orgSlug,
      workspaceSlug,
      orgListingId: listing.id,
      enabled,
    });
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(listing.id);
      return next;
    });
    if (!result.ok) setError(listing.id, result.error ?? "Update failed");
  };

  // Empty state
  if (orgListings.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 py-20 text-center"
        data-testid="integrations-empty-state"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
          <Plug className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-base font-medium text-foreground">No integrations yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Your org admin hasn&apos;t installed any plugins yet. Ask them to browse the
            marketplace from{" "}
            <Link
              href={org.settings.plugins({ orgSlug })}
              className="text-primary underline"
            >
              Org Settings → Plugins
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="workspace-integrations-panel">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold">Installed Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Enable or disable plugins for this workspace, and connect credentials.
        </p>
      </div>

      <div
        className="overflow-hidden rounded-xl border border-border/60"
        data-testid="integrations-table"
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/40 bg-muted/30 text-xs text-muted-foreground">
              <th className="px-4 py-2 text-left font-medium">Plugin</th>
              <th className="px-4 py-2 text-left font-medium">Type</th>
              <th className="px-4 py-2 text-left font-medium">Auth</th>
              <th className="px-4 py-2 text-left font-medium">Health</th>
              <th className="px-4 py-2 text-left font-medium">Enabled</th>
              {canManage && (
                <th className="px-4 py-2 text-left font-medium">Credential</th>
              )}
            </tr>
          </thead>
          <tbody>
            {orgListings.map((listing) => {
              const install = wsInstallMap[listing.id];
              const orgDisabled = !listing.enabled;
              const wsEnabled = install?.enabled ?? false;
              const healthStatus = install?.healthStatus ?? null;

              return (
                <React.Fragment key={listing.id}>
                  <tr
                    className="border-b border-border/30 last:border-0"
                    data-testid={`integrations-row-${listing.id}`}
                  >
                    {/* Plugin name + icon */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {listing.iconUrl ? (
                          <Image
                            src={listing.iconUrl}
                            alt=""
                            width={24}
                            height={24}
                            className="h-6 w-6 rounded object-contain flex-shrink-0"
                            aria-hidden="true"
                          />
                        ) : (
                          <span className="flex h-6 w-6 items-center justify-center rounded bg-muted flex-shrink-0">
                            <Plug
                              className="h-3.5 w-3.5 text-muted-foreground"
                              aria-hidden="true"
                            />
                          </span>
                        )}
                        <div>
                          <p className="font-medium">{listing.title ?? listing.name}</p>
                          <p className="text-xs text-muted-foreground">{listing.name}</p>
                        </div>
                      </div>
                    </td>

                    {/* Type badge */}
                    <td className="px-4 py-3">
                      <Badge variant={pluginTypeBadgeVariant(listing.pluginType)} size="sm">
                        {listing.pluginType.replace(/_/g, " ")}
                      </Badge>
                    </td>

                    {/* Auth badge */}
                    <td className="px-4 py-3">
                      <Badge variant={authKindBadgeVariant(listing.authKind)} size="sm">
                        {listing.authKind}
                      </Badge>
                    </td>

                    {/* Health status */}
                    <td className="px-4 py-3">
                      <HealthIcon status={healthStatus} />
                    </td>

                    {/* Enable toggle */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <Switch
                          checked={wsEnabled}
                          onCheckedChange={(checked) => handleToggle(listing, checked)}
                          disabled={
                            !canManage || orgDisabled || pendingIds.has(listing.id)
                          }
                          aria-label={`${wsEnabled ? "Disable" : "Enable"} ${listing.title ?? listing.name} in this workspace`}
                          data-testid={`integrations-toggle-${listing.id}`}
                        />
                        {orgDisabled && (
                          <span
                            className="ml-1 text-xs text-muted-foreground"
                            title="Enable this plugin at the org level first"
                          >
                            (org disabled)
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Credential action */}
                    {canManage && (
                      <td className="px-4 py-3">
                        {listing.authKind === "secret" && (
                          <SecretForm
                            orgSlug={orgSlug}
                            workspaceSlug={workspaceSlug}
                            orgListingId={listing.id}
                            setSecretAction={setSecretAction}
                          />
                        )}
                        {listing.authKind === "oauth" && (
                          <span data-testid={`plugin-connect-btn-${listing.id}`}>
                            <Button
                              variant="outline"
                              size="sm"
                              render={
                                <a
                                  href={`/api/v1/mcp/oauth/authorize?orgSlug=${orgSlug}&workspaceSlug=${workspaceSlug}&orgListingId=${listing.id}`}
                                  rel="noopener noreferrer"
                                />
                              }
                              data-testid={`integrations-oauth-btn-${listing.id}`}
                            >
                              <ExternalLink
                                className="mr-1 h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              {install ? "Reconnect" : "Connect"}
                            </Button>
                          </span>
                        )}
                        {/* Auth status indicator for E2E (shows "connected" when install row exists) */}
                        {listing.authKind === "oauth" && install && (
                          <span
                            className="ml-2 text-xs text-success"
                            data-testid={`plugin-auth-status-${listing.id}`}
                          >
                            connected
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                  {errors[listing.id] && (
                    <tr>
                      <td
                        colSpan={canManage ? 6 : 5}
                        className="px-4 pb-2"
                      >
                        <p className="text-xs text-destructive">{errors[listing.id]}</p>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
