"use client";
/**
 * effective-scope-panel.tsx — the Review step's single accountability view of
 * the agent's EFFECTIVE scope (role ceiling ∩ agent configuration) across
 * all four dimensions: capabilities, graph, MCP, skills/subagents.
 *
 * Display-only: the numbers come from computeEffectiveScopeView, which calls
 * the resolver's own exported intersection helpers — nothing here enforces.
 */
import * as React from "react";
import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  computeEffectiveScopeView,
  type EffectiveScopeInput,
} from "./effective-scope";

function EffectBadge({
  effect,
}: {
  effect: "allow" | "deny" | "require_approval" | "default";
}) {
  const label =
    effect === "require_approval"
      ? "needs approval"
      : effect === "default"
        ? "role default"
        : effect;
  const variant =
    effect === "allow"
      ? ("outline" as const)
      : effect === "deny"
        ? ("default" as const)
        : ("secondary" as const);
  return (
    <Badge variant={variant} size="sm" className="text-[10px]">
      {label}
    </Badge>
  );
}

function CapabilityList({
  label,
  capabilities,
  testId,
}: {
  label: string;
  capabilities: string[];
  testId: string;
}) {
  const [open, setOpen] = React.useState(false);
  if (capabilities.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        data-testid={`${testId}-toggle`}
      >
        {open ? (
          <ChevronUp className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        )}
        {label} ({capabilities.length})
      </button>
      {open ? (
        <ul
          className="mt-1 max-h-48 overflow-y-auto rounded-md border bg-muted/20 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground"
          data-testid={`${testId}-list`}
        >
          {capabilities.map((cap) => (
            <li key={cap}>{cap}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function DimensionCard({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div
      className="rounded-md border bg-muted/10 px-3 py-2.5"
      data-testid={testId}
    >
      <div className="mb-1.5 text-xs font-medium text-foreground">{title}</div>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

export function EffectiveScopePanel(props: EffectiveScopeInput) {
  const view = React.useMemo(() => computeEffectiveScopeView(props), [props]);

  const graph = view.graph.effective;
  const budget = graph?.budget;

  return (
    <section
      className="flex flex-col gap-2.5"
      aria-label="Effective scope"
      data-testid="effective-scope-panel"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-medium text-foreground">Effective scope</h3>
        {view.roleName ? (
          <Badge
            variant="secondary"
            size="sm"
            data-testid="effective-scope-role"
          >
            {view.roleName}
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          role ceiling ∩ agent configuration — display of what the runtime
          enforces, not an override of it.
        </span>
      </div>

      {!view.ceilingKnown && view.roleName ? (
        <p
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
          role="status"
          data-testid="effective-scope-ceiling-unknown"
        >
          This custom role does not publish its resource ceilings to the app —
          graph and MCP show the agent&rsquo;s declared configuration; the
          runtime still enforces the role&rsquo;s full ceiling.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {/* ── Capabilities ─────────────────────────────────────────────── */}
        <DimensionCard title="Capabilities" testId="scope-capabilities">
          {view.capabilities.known ? (
            <>
              <p
                className="tabular-nums"
                data-testid="scope-capabilities-counts"
              >
                <span className="text-success">
                  {view.capabilities.allow.length} allowed
                </span>
                {" · "}
                <span className="text-warning">
                  {view.capabilities.requireApproval.length} need approval
                </span>
                {" · "}
                <span className="text-destructive">
                  {view.capabilities.deny.length} denied
                </span>
              </p>
              <CapabilityList
                label="Allowed"
                capabilities={view.capabilities.allow}
                testId="scope-cap-allow"
              />
              <CapabilityList
                label="Need approval"
                capabilities={view.capabilities.requireApproval}
                testId="scope-cap-approval"
              />
              <CapabilityList
                label="Denied"
                capabilities={view.capabilities.deny}
                testId="scope-cap-deny"
              />
            </>
          ) : (
            <p data-testid="scope-capabilities-unknown">
              Grant details unavailable — the role&rsquo;s capability list could
              not be loaded. The runtime still enforces it.
            </p>
          )}
          {view.capabilities.equipped.length > 0 ? (
            <div className="space-y-1 border-t border-border/60 pt-1.5">
              <p className="font-medium text-foreground">
                Equipped capabilities
              </p>
              <ul className="space-y-0.5">
                {view.capabilities.equipped.map((item) => (
                  <li
                    key={item.ref}
                    className="flex items-center justify-between gap-2"
                    data-testid={`scope-equipped-${item.ref}`}
                  >
                    <span className="truncate font-mono text-[11px]">
                      {item.ref}
                    </span>
                    <EffectBadge effect={item.effect} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DimensionCard>

        {/* ── Graph ─────────────────────────────────────────────────────── */}
        <DimensionCard title="Graph" testId="scope-graph">
          <p data-testid="scope-graph-mode">
            Mode:{" "}
            <span className="font-medium text-foreground">
              {graph?.mode ?? view.graph.declared.mode}
            </span>
            {view.graph.ceiling?.mode === "read" &&
            view.graph.declared.mode === "extend" ? (
              <span className="text-warning"> (capped by role)</span>
            ) : null}
          </p>
          <p data-testid="scope-graph-budget" className="tabular-nums">
            Budget: {budget?.maxHops ?? view.graph.declared.maxHops} hops ·{" "}
            {budget?.maxNodes ?? view.graph.declared.maxNodes} nodes
            {budget?.maxTraversalMs !== undefined
              ? ` · ${budget.maxTraversalMs}ms`
              : ""}
          </p>
          <p data-testid="scope-graph-types">
            {graph?.labels !== undefined && graph.labels.length > 0
              ? `Types: ${graph.labels.join(", ")}`
              : graph?.labels !== undefined
                ? "Types: none in scope"
                : "Types: all permitted types"}
          </p>
        </DimensionCard>

        {/* ── MCP ───────────────────────────────────────────────────────── */}
        <DimensionCard title="MCP tools" testId="scope-mcp">
          {view.mcp.rules === null ? (
            <p>No MCP restrictions published by this role.</p>
          ) : view.mcp.summary ? (
            <p data-testid="scope-mcp-summary">{view.mcp.summary}</p>
          ) : (
            <ul className="space-y-0.5" data-testid="scope-mcp-rules">
              {view.mcp.rules.map((rule, i) => (
                <li
                  key={`${rule.pattern}-${i}`}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="truncate font-mono text-[11px]">
                    {rule.pattern}
                  </span>
                  <Badge variant="outline" size="sm" className="text-[10px]">
                    {rule.effect}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <p data-testid="scope-mcp-servers">
            {view.mcp.equippedServers.length > 0
              ? `Equipped servers: ${view.mcp.equippedServers.join(", ")}`
              : "No MCP servers equipped."}
          </p>
        </DimensionCard>

        {/* ── Skills & subagents ────────────────────────────────────────── */}
        <DimensionCard title="Skills & subagents" testId="scope-skills">
          <p data-testid="scope-skills-list">
            {view.skills.equipped.length > 0
              ? `Skills: ${view.skills.effective.join(", ")}` +
                (view.skills.effective.length < view.skills.equipped.length
                  ? ` (${view.skills.equipped.length - view.skills.effective.length} outside the role ceiling)`
                  : "")
              : "No skills equipped."}
          </p>
          <p data-testid="scope-subagents-list">
            {view.subagents.equipped.length > 0
              ? `Subagents: ${view.subagents.effective.join(", ")}` +
                (view.subagents.effective.length <
                view.subagents.equipped.length
                  ? ` (${view.subagents.equipped.length - view.subagents.effective.length} outside the role ceiling)`
                  : "")
              : "No subagents equipped."}
          </p>
          {!view.skills.constrained && !view.subagents.constrained ? (
            <p>
              The role does not constrain these — the agent loads only what it
              equips.
            </p>
          ) : null}
        </DimensionCard>
      </div>
    </section>
  );
}
