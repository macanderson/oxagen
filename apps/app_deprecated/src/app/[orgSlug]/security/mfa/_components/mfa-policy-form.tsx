"use client";
/**
 * mfa-policy-form.tsx — interactive MFA enforcement policy form.
 *
 * Switch (require MFA org-wide) + grace-period Select + Save.
 * Owner/admin only (the page enforces role server-side; this is presentational).
 */

import * as React from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { saveMfaPolicyAction, type SaveMfaPolicyInput } from "../actions";

const GRACE_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Immediate (no grace period)" },
  { value: 24, label: "24 hours" },
  { value: 48, label: "48 hours" },
  { value: 72, label: "72 hours" },
  { value: 168, label: "7 days" },
  { value: 336, label: "14 days" },
  { value: 720, label: "30 days" },
];

export interface MfaPolicyFormProps {
  orgSlug: string;
  /** Whether this user has permission to save (owner/admin). */
  canEdit: boolean;
  initialMfaRequired: boolean;
  initialMfaGraceHours: number;
}

export function MfaPolicyForm({
  orgSlug,
  canEdit,
  initialMfaRequired,
  initialMfaGraceHours,
}: MfaPolicyFormProps) {
  const [mfaRequired, setMfaRequired] = React.useState(initialMfaRequired);
  const [mfaGraceHours, setMfaGraceHours] =
    React.useState(initialMfaGraceHours);
  const [status, setStatus] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const isDirty =
    mfaRequired !== initialMfaRequired ||
    mfaGraceHours !== initialMfaGraceHours;

  async function handleSave() {
    setStatus("saving");
    setErrorMsg(null);
    const input: SaveMfaPolicyInput = { orgSlug, mfaRequired, mfaGraceHours };
    const result = await saveMfaPolicyAction(input);
    if (result.ok) {
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2500);
    } else {
      setStatus("error");
      setErrorMsg(
        "error" in result
          ? result.error
          : "Permission denied. Owner or admin role required.",
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* MFA required toggle */}
      <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-muted/30 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">
            Require MFA for all members
          </span>
          <span className="text-xs text-muted-foreground">
            When enabled, every member must enroll in multi-factor
            authentication. Members who have not enrolled are blocked after the
            grace period. (CC6.1 / CC6.2)
          </span>
        </div>
        <Switch
          checked={mfaRequired}
          onCheckedChange={canEdit ? setMfaRequired : undefined}
          disabled={!canEdit}
          aria-label="Require MFA for all members"
          className="mt-2 sm:mt-0 sm:ml-6 shrink-0"
        />
      </div>

      {/* Grace period select */}
      {mfaRequired && (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="grace-period"
            className="text-sm font-medium text-foreground"
          >
            Enforcement grace period
          </label>
          <p className="text-xs text-muted-foreground">
            How long a member without MFA can still access the org before being
            blocked. Applies from the moment the policy is enabled.
          </p>
          <select
            id="grace-period"
            value={mfaGraceHours}
            onChange={(e) =>
              canEdit && setMfaGraceHours(Number(e.target.value))
            }
            disabled={!canEdit}
            className="w-full max-w-xs rounded-md border border-border/60 bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            {GRACE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Status feedback */}
      {status === "error" && errorMsg && (
        <p className="text-sm text-destructive">{errorMsg}</p>
      )}
      {status === "saved" && (
        <p className="text-sm text-success" role="status">
          Policy saved.
        </p>
      )}

      {/* Save button */}
      {canEdit && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            disabled={!isDirty || status === "saving"}
            onClick={handleSave}
          >
            {status === "saving" ? "Saving…" : "Save policy"}
          </Button>
          {!isDirty && status === "idle" && (
            <Badge variant="muted" className="text-xs">
              No changes
            </Badge>
          )}
        </div>
      )}

      {!canEdit && (
        <p className="text-xs text-muted-foreground">
          Owner or admin role required to change the MFA policy.
        </p>
      )}
    </div>
  );
}
