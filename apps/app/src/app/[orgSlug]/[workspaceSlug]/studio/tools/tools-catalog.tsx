"use client";
/**
 * tools-catalog.tsx — Studio → Tools catalog panel.
 *
 * Read-only, hand-rolled table over the workspace's agent tools (from
 * `agent.tool.list`, wrapped by `listAgentTools`). Supports client-side
 * search (name/domain) plus domain and risk-level filters, and opens a Sheet
 * with the full tool detail on row click. No mutations — equipping tools
 * happens in the Agent Builder, installing new ones happens in the
 * Marketplace, and grants live under Access → Roles.
 */
import * as React from "react";
import Link from "next/link";
import { Search, Flag, ExternalLink, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetPanel,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type { AgentToolRow } from "@/lib/studio/tools";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RiskFilter = "all" | AgentToolRow["riskLevel"];

interface ToolsCatalogProps {
  tools: AgentToolRow[];
  /** `workspace.marketplace.root(ctx)` — "Install more" links here. */
  marketplaceHref: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALL_DOMAINS = "all";

function riskBadgeVariant(risk: AgentToolRow["riskLevel"]): "outline" | "warning" | "error" {
  if (risk === "high") return "error";
  if (risk === "medium") return "warning";
  return "outline";
}

function riskLabel(risk: AgentToolRow["riskLevel"]): string {
  return risk.charAt(0).toUpperCase() + risk.slice(1);
}

/** Pure filter logic, exported for unit testing without mounting the component. */
export function filterTools(
  tools: AgentToolRow[],
  query: string,
  domain: string,
  risk: RiskFilter,
): AgentToolRow[] {
  const q = query.trim().toLowerCase();
  return tools.filter((tool) => {
    if (domain !== ALL_DOMAINS && tool.domain !== domain) return false;
    if (risk !== "all" && tool.riskLevel !== risk) return false;
    if (!q) return true;
    return (
      tool.name.toLowerCase().includes(q) ||
      tool.domain.toLowerCase().includes(q) ||
      (tool.category ?? "").toLowerCase().includes(q) ||
      tool.description.toLowerCase().includes(q)
    );
  });
}

function uniqueDomains(tools: AgentToolRow[]): string[] {
  return Array.from(new Set(tools.map((t) => t.domain))).sort((a, b) => a.localeCompare(b));
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ToolsCatalog({ tools, marketplaceHref }: ToolsCatalogProps) {
  const [query, setQuery] = React.useState("");
  const [domain, setDomain] = React.useState<string>(ALL_DOMAINS);
  const [risk, setRisk] = React.useState<RiskFilter>("all");
  const [selected, setSelected] = React.useState<AgentToolRow | null>(null);

  const domains = React.useMemo(() => uniqueDomains(tools), [tools]);
  const filtered = React.useMemo(
    () => filterTools(tools, query, domain, risk),
    [tools, query, domain, risk],
  );

  return (
    <div className="flex flex-col gap-4" data-testid="tools-catalog">
      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 w-full max-w-xs">
            <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
            <Input
              placeholder="Search tools..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8"
              aria-label="Search agent tools"
              data-testid="tools-search-input"
            />
          </div>

          <Select value={domain} onValueChange={(v) => setDomain(v ?? ALL_DOMAINS)}>
            <SelectTrigger size="sm" className="w-40" aria-label="Filter by domain">
              <SelectValue placeholder="All domains" />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={ALL_DOMAINS}>All domains</SelectItem>
              {domains.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>

          <Select value={risk} onValueChange={(v) => setRisk((v ?? "all") as RiskFilter)}>
            <SelectTrigger size="sm" className="w-36" aria-label="Filter by risk level">
              <SelectValue placeholder="All risk levels" />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All risk</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectPopup>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground whitespace-nowrap">
            {filtered.length} tool{filtered.length !== 1 ? "s" : ""}
          </div>
          <Button
            variant="outline"
            size="sm"
            render={<Link href={marketplaceHref} />}
            data-testid="tools-install-more-button"
          >
            Install more in Marketplace
          </Button>
        </div>
      </div>

      {/* Table */}
      {tools.length === 0 ? (
        <ToolsCatalogEmptyState
          message="No agent tools are available in this workspace yet."
          marketplaceHref={marketplaceHref}
        />
      ) : filtered.length === 0 ? (
        <ToolsCatalogEmptyState message="No tools match your search or filters." />
      ) : (
        <div className="rounded-md border bg-card overflow-x-auto" data-testid="tools-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Tool name
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Domain</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Category
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Risk</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Approval
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  External
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((tool, idx) => (
                <tr
                  key={tool.name}
                  onClick={() => setSelected(tool)}
                  className={`border-b last:border-0 hover:bg-muted/20 transition-colors cursor-pointer${idx % 2 === 1 ? " bg-muted/5" : ""}`}
                  data-testid={`tool-row-${tool.name}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground font-mono text-xs">
                        {tool.name}
                      </span>
                      <span className="text-xs text-muted-foreground line-clamp-1">
                        {tool.description}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{tool.domain}</td>
                  <td className="px-4 py-3 text-muted-foreground">{tool.category ?? "—"}</td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={riskBadgeVariant(tool.riskLevel)}
                      className="text-xs"
                      data-testid={`tool-risk-badge-${tool.name}`}
                    >
                      {riskLabel(tool.riskLevel)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {tool.requiresApproval ? (
                      <Flag
                        className="h-3.5 w-3.5 text-warning-foreground"
                        aria-label="Requires approval"
                        data-testid={`tool-approval-flag-${tool.name}`}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {tool.external ? (
                      <ExternalLink
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-label="External tool"
                        data-testid={`tool-external-icon-${tool.name}`}
                      />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail sheet */}
      <Sheet
        open={selected !== null}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
      >
        <SheetPopup>
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono text-base">{selected.name}</SheetTitle>
                <SheetDescription>{selected.description}</SheetDescription>
              </SheetHeader>
              <SheetPanel>
                <dl className="flex flex-col gap-3 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">Domain</dt>
                    <dd className="font-medium text-foreground">{selected.domain}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">Category</dt>
                    <dd className="font-medium text-foreground">{selected.category ?? "—"}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">Risk level</dt>
                    <dd>
                      <Badge variant={riskBadgeVariant(selected.riskLevel)} className="text-xs">
                        {riskLabel(selected.riskLevel)}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">Requires approval</dt>
                    <dd className="font-medium text-foreground">
                      {selected.requiresApproval ? "Yes" : "No"}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <dt className="text-muted-foreground">External</dt>
                    <dd className="font-medium text-foreground">
                      {selected.external ? "Yes" : "No"}
                    </dd>
                  </div>
                </dl>
                <p className="mt-6 text-xs text-muted-foreground border-t pt-4">
                  Equip this in the Agent Builder · manage grants in Access → Roles.
                </p>
              </SheetPanel>
            </>
          ) : null}
        </SheetPopup>
      </Sheet>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function ToolsCatalogEmptyState({
  message,
  marketplaceHref,
}: {
  message: string;
  marketplaceHref?: string;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground"
      data-testid="tools-empty-state"
    >
      <Wrench className="h-8 w-8 opacity-40" aria-hidden="true" />
      <p className="text-sm">{message}</p>
      {marketplaceHref ? (
        <Button
          variant="outline"
          size="sm"
          render={<Link href={marketplaceHref} />}
          data-testid="tools-empty-install-button"
        >
          Install more in Marketplace
        </Button>
      ) : null}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

export function ToolsCatalogSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 h-8 max-w-xs">
        <Skeleton className="h-8 w-full" />
      </div>
      <div className="rounded-md border overflow-hidden">
        <div className="bg-muted/40 border-b px-4 py-3 flex gap-8">
          {["Tool name", "Domain", "Category", "Risk", "Approval", "External"].map((h) => (
            <Skeleton key={h} className="h-4 w-20" />
          ))}
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b last:border-0 flex gap-8 items-center">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-4 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}
