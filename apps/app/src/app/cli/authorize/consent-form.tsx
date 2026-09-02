"use client";
/**
 * ConsentForm — interactive consent UI for the CLI browser-login flow.
 *
 * A stock, glass-free component that lets the user pick an org + workspace
 * and click Approve or Cancel. All security-critical validation happens in
 * the server actions (actions.ts); this component only handles presentation
 * and the selection state.
 */

import { useCallback, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { approveCliAuth, cancelCliAuth } from "./actions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceOption {
  id: string;
  slug: string;
  name: string;
}

export interface OrgOption {
  id: string;
  slug: string;
  name: string;
  workspaces: WorkspaceOption[];
}

export interface ConsentFormProps {
  /** Shown as the requesting device / app name. */
  label: string;
  /** Loopback redirect URI — passed through as a hidden field for re-validation. */
  redirectUri: string;
  /** Anti-CSRF / correlation state value. */
  state: string;
  /** PKCE S256 code challenge. */
  codeChallenge: string;
  /** Orgs (with workspaces) the user can authorize against. */
  orgs: OrgOption[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConsentForm({
  label,
  redirectUri,
  state,
  codeChallenge,
  orgs,
}: ConsentFormProps) {
  const defaultOrg = orgs[0];
  const [selectedOrgSlug, setSelectedOrgSlug] = useState<string>(
    defaultOrg?.slug ?? "",
  );

  const currentOrg = orgs.find((o) => o.slug === selectedOrgSlug) ?? defaultOrg;
  const workspaces = currentOrg?.workspaces ?? [];

  const [selectedWsSlug, setSelectedWsSlug] = useState<string>(
    workspaces[0]?.slug ?? "",
  );

  // When the org changes, reset the workspace to the first of the new org.
  // onValueChange from @base-ui/react Select can pass null when deselected.
  const handleOrgChange = useCallback(
    (slug: string | null) => {
      if (!slug) return;
      setSelectedOrgSlug(slug);
      const org = orgs.find((o) => o.slug === slug);
      setSelectedWsSlug(org?.workspaces[0]?.slug ?? "");
    },
    [orgs],
  );

  const [error, setError] = useState<string | null>(null);
  const [isPendingApprove, startApprove] = useTransition();
  const [isPendingCancel, startCancel] = useTransition();

  function handleApprove() {
    setError(null);
    startApprove(async () => {
      const fd = new FormData();
      fd.set("redirect_uri", redirectUri);
      fd.set("state", state);
      fd.set("code_challenge", codeChallenge);
      fd.set("code_challenge_method", "S256");
      fd.set("label", label);
      fd.set("org_slug", selectedOrgSlug);
      fd.set("workspace_slug", selectedWsSlug);
      try {
        await approveCliAuth(fd);
      } catch (err) {
        // Next.js redirect() throws; let it propagate so the browser follows it.
        // Any genuine error (not a redirect) should surface to the user.
        if (err instanceof Error && !err.message.includes("NEXT_REDIRECT")) {
          setError(err.message);
        } else {
          throw err;
        }
      }
    });
  }

  function handleCancel() {
    setError(null);
    startCancel(async () => {
      const fd = new FormData();
      fd.set("redirect_uri", redirectUri);
      fd.set("state", state);
      try {
        await cancelCliAuth(fd);
      } catch (err) {
        if (err instanceof Error && !err.message.includes("NEXT_REDIRECT")) {
          setError(err.message);
        } else {
          throw err;
        }
      }
    });
  }

  const isPending = isPendingApprove || isPendingCancel;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-md space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Authorize the Oxagen CLI
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{label}</span> is
            requesting access to your Oxagen workspace.
          </p>
        </div>

        {/* Org picker */}
        <div className="space-y-2">
          <Label htmlFor="org-select">Organization</Label>
          <Select
            value={selectedOrgSlug}
            onValueChange={handleOrgChange}
            disabled={isPending || orgs.length <= 1}
          >
            <SelectTrigger id="org-select">
              <SelectValue placeholder="Select an organization" />
            </SelectTrigger>
            <SelectContent>
              {orgs.map((org) => (
                <SelectItem key={org.slug} value={org.slug}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Workspace picker */}
        <div className="space-y-2">
          <Label htmlFor="ws-select">Workspace</Label>
          <Select
            value={selectedWsSlug}
            onValueChange={(v) => {
              if (v) setSelectedWsSlug(v);
            }}
            disabled={isPending || workspaces.length <= 1}
          >
            <SelectTrigger id="ws-select">
              <SelectValue placeholder="Select a workspace" />
            </SelectTrigger>
            <SelectContent>
              {workspaces.map((ws) => (
                <SelectItem key={ws.slug} value={ws.slug}>
                  {ws.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {workspaces.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No workspaces available in this organization.
            </p>
          )}
        </div>

        {/* Permission summary */}
        <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground space-y-1">
          <p className="font-medium text-foreground text-xs uppercase tracking-wide">
            This will grant the CLI permission to:
          </p>
          <ul className="list-disc list-inside space-y-0.5 text-xs">
            <li>Create and manage API keys in the selected workspace</li>
            <li>Act on your behalf for CLI operations</li>
          </ul>
        </div>

        {/* Error */}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          <Button
            variant="outline"
            className="flex-1"
            onClick={handleCancel}
            disabled={isPending}
          >
            {isPendingCancel ? "Cancelling…" : "Cancel"}
          </Button>
          <Button
            className="flex-1"
            onClick={handleApprove}
            disabled={isPending || !selectedOrgSlug || !selectedWsSlug}
          >
            {isPendingApprove ? "Authorizing…" : "Approve"}
          </Button>
        </div>
      </div>
    </div>
  );
}
