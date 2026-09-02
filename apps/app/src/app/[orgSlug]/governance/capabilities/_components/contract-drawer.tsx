"use client";

/**
 * ContractDrawer — one typed contract rendered as the enforced object.
 *
 * Six sections, one per accountability-chain link: identity (role grants),
 * knowledge scope (tenancy + audit target), permitted action (mode, surfaces,
 * IO field specs), commercial terms (billing gate, entitlement pack, 30d
 * usage), verified outcome (test-evidence layers + risk), audit record
 * (recent events naming this capability).
 */

import type { AuditEvent } from "@oxagen/oxagen/contracts/audit.log.query";
import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";
import type {
  CapabilityRegistryDetail,
  CapabilityFieldSpec,
} from "@oxagen/oxagen/contracts/capability.registry.get";
import {
  Drawer,
  LoadingState,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { CapabilityInsights, CapabilityUsageSlice } from "../actions";

function formatUsdFromMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function ChainSection({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 py-3" aria-label={title}>
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="flex size-5 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-foreground">
          {step}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function RoleGrantChips({ roles }: { roles: Record<string, string> }) {
  const entries = Object.entries(roles);
  if (entries.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">No default grants</span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([role, effect]) => (
        <Badge
          key={role}
          size="sm"
          variant={
            effect === "allow"
              ? "success-soft"
              : effect === "require_approval"
                ? "warning-soft"
                : "error-soft"
          }
        >
          {role}: {effect}
        </Badge>
      ))}
    </div>
  );
}

function FieldTable({
  title,
  fields,
}: {
  title: string;
  fields: CapabilityFieldSpec[];
}) {
  if (fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {title}: no top-level fields (opaque or empty schema).
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-foreground">{title}</p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr className="border-b border-border">
              <th className="px-2 py-1.5 font-medium">Field</th>
              <th className="px-2 py-1.5 font-medium">Type</th>
              <th className="px-2 py-1.5 font-medium">Required</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr
                key={f.name}
                className="border-b border-border last:border-b-0"
              >
                <td className="px-2 py-1.5 font-mono">{f.name}</td>
                <td className="px-2 py-1.5 text-muted-foreground">{f.type}</td>
                <td className="px-2 py-1.5">{f.required ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UsageLine({ usage }: { usage: CapabilityUsageSlice | null }) {
  if (usage === null) {
    return (
      <p className="text-xs text-muted-foreground">Usage data unavailable.</p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      Last 30 days:{" "}
      <span className="font-medium text-foreground">
        {formatUsdFromMicros(usage.costMicros)}
      </span>{" "}
      across{" "}
      <span className="font-medium text-foreground">
        {usage.executions.toLocaleString()}
      </span>{" "}
      metered calls ({(usage.inputTokens + usage.outputTokens).toLocaleString()}{" "}
      tokens).
    </p>
  );
}

function AuditList({ events }: { events: AuditEvent[] | null }) {
  if (events === null) {
    return (
      <p className="text-xs text-muted-foreground">Audit feed unavailable.</p>
    );
  }
  if (events.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No recent audit events name this capability.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {events.map((e, i) => (
        <li
          key={`${e.occurredAt}-${i}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"
        >
          <Badge
            size="sm"
            variant={
              e.outcome === "deny" || e.outcome === "error"
                ? "error-soft"
                : "success-soft"
            }
          >
            {e.outcome ?? "event"}
          </Badge>
          <span className="font-mono">{e.eventType}</span>
          <span className="ml-auto text-muted-foreground">
            {formatWhen(e.occurredAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface ContractDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The catalog row that was clicked (renders immediately). */
  summary: CapabilityRegistrySummary | null;
  /** Async detail + usage + audit; null while loading. */
  insights: CapabilityInsights | null;
}

export function ContractDrawer({
  open,
  onOpenChange,
  summary,
  insights,
}: ContractDrawerProps) {
  if (!summary) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} title="Contract">
        <LoadingState variant="page" />
      </Drawer>
    );
  }

  const detail: CapabilityRegistryDetail | null = insights?.detail ?? null;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={summary.name}
      description={summary.description}
      className="sm:max-w-xl"
    >
      <div className="flex flex-col" data-testid="contract-drawer">
        {insights?.error ? (
          <p className="py-2 text-xs text-error">{insights.error}</p>
        ) : null}

        <ChainSection step={1} title="Identity — who may call it">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Fallback effect:</span>
              <Badge
                size="sm"
                variant={
                  summary.defaultEffect === "allow"
                    ? "success-soft"
                    : "warning-soft"
                }
              >
                {summary.defaultEffect}
              </Badge>
              {summary.agent?.requiresApproval ? (
                <Badge size="sm" variant="warning-soft">
                  human approval required
                </Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">Org role grants</p>
            <RoleGrantChips roles={summary.orgRoles} />
            <p className="text-xs text-muted-foreground">
              Workspace role grants
            </p>
            <RoleGrantChips roles={summary.workspaceRoles} />
          </div>
        </ChainSection>
        <Separator />

        <ChainSection step={2} title="Knowledge scope — what it may touch">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              size="sm"
              variant={summary.scoped ? "success-soft" : "warning-soft"}
            >
              {summary.scoped ? "tenant-scoped" : "global"}
            </Badge>
            <Badge size="sm" variant="muted">
              domain: {summary.domain}
            </Badge>
            {summary.auditTargetKind ? (
              <Badge size="sm" variant="muted">
                acts on: {summary.auditTargetKind}
              </Badge>
            ) : null}
          </div>
        </ChainSection>
        <Separator />

        <ChainSection step={3} title="Permitted action — what it does">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge size="sm" variant="muted">
                {summary.mode}
              </Badge>
              {summary.surfaces.map((s) => (
                <Badge key={s} size="sm" variant="info-soft">
                  {s}
                </Badge>
              ))}
              <Badge
                size="sm"
                variant={
                  summary.sensitivity === "low"
                    ? "success-soft"
                    : summary.sensitivity === "medium"
                      ? "warning-soft"
                      : "error-soft"
                }
              >
                {summary.sensitivity}
              </Badge>
            </div>
            {detail ? (
              <>
                <FieldTable title="Input" fields={detail.inputFields} />
                <FieldTable title="Output" fields={detail.outputFields} />
              </>
            ) : insights ? (
              <p className="text-xs text-muted-foreground">
                Field specs unavailable.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Loading field specs…
              </p>
            )}
          </div>
        </ChainSection>
        <Separator />

        <ChainSection step={4} title="Commercial terms — what it costs">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                size="sm"
                variant={summary.noBillingGate ? "muted" : "info-soft"}
              >
                {summary.noBillingGate
                  ? "billing-gate exempt"
                  : "billing-gated"}
              </Badge>
              {summary.plugin ? (
                <Badge size="sm" variant="warning-soft">
                  pack: {summary.plugin.id} ({summary.plugin.tier}
                  {summary.plugin.minPlanTier
                    ? ` · min ${summary.plugin.minPlanTier}`
                    : ""}
                  )
                </Badge>
              ) : (
                <Badge size="sm" variant="muted">
                  built-in (no pack entitlement)
                </Badge>
              )}
            </div>
            {insights ? (
              <UsageLine usage={insights.usage} />
            ) : (
              <p className="text-xs text-muted-foreground">Loading usage…</p>
            )}
          </div>
        </ChainSection>
        <Separator />

        <ChainSection step={5} title="Verified outcome — how it is proven">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              size="sm"
              variant={
                summary.layers.includes("unit") ? "success-soft" : "error-soft"
              }
            >
              unit {summary.layers.includes("unit") ? "✓" : "—"}
            </Badge>
            <Badge
              size="sm"
              variant={
                summary.layers.includes("e2e") ? "success-soft" : "muted"
              }
            >
              e2e {summary.layers.includes("e2e") ? "✓" : "—"}
            </Badge>
            {summary.agent ? (
              <Badge size="sm" variant="muted">
                risk: {summary.agent.riskLevel}
              </Badge>
            ) : null}
          </div>
        </ChainSection>
        <Separator />

        <ChainSection step={6} title="Audit record — what it leaves behind">
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">
              Every invocation is recorded by the kernel
              {detail?.auditTargetIdField
                ? ` with the acted-on ${summary.auditTargetKind ?? "object"} (from input.${detail.auditTargetIdField})`
                : ""}
              .
            </p>
            {insights ? (
              <AuditList events={insights.audit} />
            ) : (
              <p className="text-xs text-muted-foreground">
                Loading audit feed…
              </p>
            )}
          </div>
        </ChainSection>

        {detail &&
        (detail.produces.length > 0 ||
          detail.consumes.length > 0 ||
          detail.chainHints.length > 0) ? (
          <>
            <Separator />
            <section
              className="flex flex-col gap-1.5 py-3"
              aria-label="Chaining"
            >
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Chaining
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {detail.produces.map((t) => (
                  <Badge key={`p-${t}`} size="sm" variant="info-soft">
                    produces {t}
                  </Badge>
                ))}
                {detail.consumes.map((t) => (
                  <Badge key={`c-${t}`} size="sm" variant="muted">
                    consumes {t}
                  </Badge>
                ))}
                {detail.chainHints.map((t) => (
                  <Badge key={`h-${t}`} size="sm" variant="muted">
                    then {t}
                  </Badge>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </Drawer>
  );
}
