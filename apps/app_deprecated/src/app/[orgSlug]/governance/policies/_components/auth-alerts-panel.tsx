"use client";

/**
 * AuthAlertsPanel — configure which org roles receive MCP auth-failure alerts
 * and whether email is sent. Backed by get_auth_alerts (initial state, server
 * page) + set_auth_alerts (saveAuthAlertsAction). Non-admins see the current
 * state read-only with the save affordance disabled (the server action
 * re-checks — the disabled button is cosmetic, not the lock).
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { saveAuthAlertsAction } from "../actions";

const ORG_ROLES = ["Owner", "Admin", "Compliance", "Billing"] as const;
type OrgRole = (typeof ORG_ROLES)[number];

export interface AuthAlertsPanelProps {
  orgSlug: string;
  initialSendEmail: boolean;
  initialRoles: string[];
  /** True when the org has never customised the setting. */
  isDefault: boolean;
  /** Whether the viewer may save (org owner/admin). */
  canEdit: boolean;
}

export function AuthAlertsPanel({
  orgSlug,
  initialSendEmail,
  initialRoles,
  isDefault,
  canEdit,
}: AuthAlertsPanelProps) {
  const [sendEmail, setSendEmail] = useState(initialSendEmail);
  const [roles, setRoles] = useState<Set<string>>(new Set(initialRoles));
  const [status, setStatus] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);
  const [saving, startTransition] = useTransition();

  function toggleRole(role: OrgRole): void {
    setRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  }

  function save(): void {
    setStatus(null);
    startTransition(async () => {
      const result = await saveAuthAlertsAction({
        orgSlug,
        sendEmail,
        roles: [...roles],
      });
      setStatus(
        result.ok
          ? { kind: "ok", text: "Alert setting saved." }
          : { kind: "error", text: result.error ?? "Saving failed." },
      );
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="auth-alerts-panel">
      <p className="text-sm text-muted-foreground">
        When an MCP credential expires or fails re-authentication, these org
        roles are alerted
        {isDefault ? " (using the platform default — not yet customised)" : ""}.
      </p>

      <fieldset className="flex flex-wrap gap-4" disabled={!canEdit || saving}>
        <legend className="sr-only">Roles that receive MCP auth alerts</legend>
        {ORG_ROLES.map((role) => (
          <label
            key={role}
            className="flex items-center gap-2 text-sm text-foreground"
          >
            <input
              type="checkbox"
              className="size-4 accent-foreground"
              checked={roles.has(role)}
              onChange={() => toggleRole(role)}
              data-testid={`alert-role-${role.toLowerCase()}`}
            />
            {role}
          </label>
        ))}
      </fieldset>

      <div className="flex items-center gap-2">
        <Switch
          id="auth-alerts-email"
          checked={sendEmail}
          onCheckedChange={(v: boolean) => setSendEmail(v)}
          disabled={!canEdit || saving}
        />
        <Label htmlFor="auth-alerts-email" className="text-sm">
          Also send email
        </Label>
      </div>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          onClick={save}
          disabled={!canEdit || saving || roles.size === 0}
          data-testid="auth-alerts-save"
        >
          {saving ? "Saving…" : "Save alert setting"}
        </Button>
        {!canEdit ? (
          <span className="text-xs text-muted-foreground">
            Only org owners and admins can change this.
          </span>
        ) : roles.size === 0 ? (
          <span className="text-xs text-warning">
            Select at least one role.
          </span>
        ) : null}
        {status ? (
          <span
            role="status"
            className={
              status.kind === "ok"
                ? "text-xs text-success"
                : "text-xs text-error"
            }
          >
            {status.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
