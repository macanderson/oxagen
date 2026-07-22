"use client";
/**
 * role-picker.tsx — the Agent Builder's Access-step role picker (Agent RBAC
 * Phase 5a, docs/specs/agent-rbac/spec.md §4 Phase 5).
 *
 * A radiogroup of role cards: the three system agent roles with their intent
 * descriptions, plus the org's custom roles where the tier allows. The picker
 * is presentation-only — the builder owns the selection and persists it via
 * assign_agent_role on save.
 *
 * Delegation-ceiling UX: an option whose grants exceed the viewer's own
 * effective access (pre-checked server-side with the SAME function the
 * contract enforces) renders disabled with an explanatory tooltip listing the
 * offending capabilities. The contract remains the authority — a race still
 * rejects with `agent_role_ceiling_exceeded`, surfaced by the builder.
 */
import * as React from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import type { AgentRoleOption } from "@/lib/workbench/agent-roles";

export interface RolePickerProps {
  options: AgentRoleOption[];
  /** Selected role name (the builder owns this state). */
  value: string;
  onChange: (roleName: string) => void;
  disabled?: boolean;
  /** True when the org tier allows custom (non-system) agent roles. */
  customRolesAvailable: boolean;
  /** Non-null when role data failed to load — degraded, honestly rendered. */
  rolesError: string | null;
  /** The role currently persisted on the agent (badge on its card). */
  assignedRoleName: string | null;
}

/** Stable, testable id fragment for a role name ("Agent Contributor" →
 *  "agent-contributor"). */
export function roleTestId(roleName: string): string {
  return roleName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function GrantCounts({ option }: { option: AgentRoleOption }) {
  if (!option.grantsKnown) {
    return (
      <span className="text-xs text-muted-foreground">
        Grant details unavailable
      </span>
    );
  }
  const allow = option.grants.filter((g) => g.effect === "allow").length;
  const approval = option.grants.filter(
    (g) => g.effect === "require_approval",
  ).length;
  const deny = option.grants.filter((g) => g.effect === "deny").length;
  return (
    <span
      className="flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground"
      data-testid={`role-grant-counts-${roleTestId(option.roleName)}`}
    >
      <span className="text-success">{allow} allowed</span>
      <span aria-hidden="true">·</span>
      <span className="text-warning">{approval} need approval</span>
      <span aria-hidden="true">·</span>
      <span className="text-destructive">{deny} denied</span>
    </span>
  );
}

const CEILING_TOOLTIP_MAX_CAPS = 3;

function ceilingTooltipText(option: AgentRoleOption): string {
  const caps = option.exceededCapabilities;
  const shown = caps.slice(0, CEILING_TOOLTIP_MAX_CAPS).join(", ");
  const more = caps.length > CEILING_TOOLTIP_MAX_CAPS
    ? ` and ${caps.length - CEILING_TOOLTIP_MAX_CAPS} more`
    : "";
  return (
    `You cannot delegate permissions you do not hold. This role grants ` +
    `capabilities beyond your own effective access` +
    (shown ? `: ${shown}${more}.` : ".")
  );
}

export function RolePicker({
  options,
  value,
  onChange,
  disabled,
  customRolesAvailable,
  rolesError,
  assignedRoleName,
}: RolePickerProps) {
  const system = options.filter((o) => o.isSystemDefault);
  const custom = options.filter((o) => !o.isSystemDefault);

  return (
    <div className="flex flex-col gap-4" data-testid="agent-role-picker">
      <p className="text-sm text-muted-foreground">
        The role is the agent&rsquo;s permission ceiling — what it may ever do.
        The configuration in the other steps is its request; at run time the
        agent gets the intersection of the two.
      </p>

      {rolesError ? (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
          data-testid="agent-role-error"
        >
          Role details could not be loaded: {rolesError}. The system roles are
          shown from their built-in definitions; grant counts and custom roles
          are unavailable until this resolves.
        </div>
      ) : null}

      <div
        role="radiogroup"
        aria-label="Agent role"
        className="flex flex-col gap-2"
      >
        {system.map((option) => (
          <RoleCard
            key={option.roleName}
            option={option}
            selected={value === option.roleName}
            assigned={assignedRoleName === option.roleName}
            disabled={disabled}
            onSelect={() => onChange(option.roleName)}
          />
        ))}

        {custom.length > 0 ? (
          <>
            <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Custom roles
            </p>
            {custom.map((option) => (
              <RoleCard
                key={option.roleName}
                option={option}
                selected={value === option.roleName}
                assigned={assignedRoleName === option.roleName}
                disabled={disabled}
                onSelect={() => onChange(option.roleName)}
              />
            ))}
          </>
        ) : null}
      </div>

      {!customRolesAvailable ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="agent-role-custom-tier-hint"
        >
          Custom agent roles are an Enterprise capability — this org&rsquo;s
          tier assigns the system roles only.
        </p>
      ) : custom.length === 0 && !rolesError ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="agent-role-custom-empty"
        >
          No custom roles in this org yet. Custom roles are defined under
          Governance &rarr; Policies and become assignable here.
        </p>
      ) : null}
    </div>
  );
}

function RoleCard({
  option,
  selected,
  assigned,
  disabled,
  onSelect,
}: {
  option: AgentRoleOption;
  selected: boolean;
  assigned: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const blocked = !option.withinCeiling;
  const isDisabled = disabled || blocked;
  const testId = roleTestId(option.roleName);

  const card = (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={isDisabled || undefined}
      disabled={isDisabled}
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:border-border hover:bg-muted/30"
      } ${isDisabled ? "cursor-not-allowed opacity-60" : ""}`}
      data-testid={`role-option-${testId}`}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${
          selected ? "border-primary" : "border-muted-foreground/40"
        }`}
        aria-hidden="true"
      >
        {selected ? (
          <span className="h-2 w-2 rounded-full bg-primary" />
        ) : null}
      </span>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">
            {option.roleName}
          </span>
          {option.isSystemDefault ? (
            <Badge variant="outline" size="sm" className="text-[10px]">
              System
            </Badge>
          ) : (
            <Badge variant="secondary" size="sm" className="text-[10px]">
              Custom
            </Badge>
          )}
          {assigned ? (
            <Badge
              variant="secondary"
              size="sm"
              className="text-[10px]"
              data-testid={`role-current-${testId}`}
            >
              <ShieldCheck className="mr-0.5 h-2.5 w-2.5" aria-hidden="true" />
              Current
            </Badge>
          ) : null}
          {blocked ? (
            <Lock
              className="h-3 w-3 text-muted-foreground"
              aria-hidden="true"
            />
          ) : null}
        </span>
        <span className="block text-xs text-muted-foreground">
          {option.description}
        </span>
        <GrantCounts option={option} />
      </span>
    </button>
  );

  if (!blocked) return card;

  // Disabled-with-tooltip: the trigger wraps the card so the explanation is
  // reachable on hover/focus even though the button itself is disabled.
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="block w-full" tabIndex={0} />}
        data-testid={`role-ceiling-blocked-${testId}`}
      >
        {card}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-sm">
        {ceilingTooltipText(option)}
      </TooltipPopup>
    </Tooltip>
  );
}
