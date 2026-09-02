"use client";

/**
 * CatalogView — client shell of the Capability & Contract catalog.
 *
 * The server page fetches the full registry (platform metadata); this
 * component filters locally (search, domain, surface-gap) and opens the
 * ContractDrawer for a row, loading detail/usage/audit through the
 * fetchCapabilityInsights server action.
 */

import { useMemo, useState, useTransition } from "react";
import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { Button } from "@/components/ui/button";
import { SearchX } from "lucide-react";
import { fetchCapabilityInsights, type CapabilityInsights } from "../actions";
import {
  filterCatalog,
  hasSurfaceGap,
  missingCoreLayers,
  allowedOrgRoles,
  type CatalogFilterState,
} from "../catalog-filter";
import { ContractDrawer } from "./contract-drawer";

export interface CatalogViewProps {
  orgSlug: string;
  rows: CapabilityRegistrySummary[];
  domains: string[];
  /** Deep-link initial filters (?domain= / ?missingLayer= / ?q=). */
  initialFilter?: Partial<CatalogFilterState>;
}

export function CatalogView({
  orgSlug,
  rows,
  domains,
  initialFilter,
}: CatalogViewProps) {
  const [filter, setFilter] = useState<CatalogFilterState>({
    q: initialFilter?.q ?? "",
    domain: initialFilter?.domain ?? "",
    gapOnly: initialFilter?.gapOnly ?? false,
    missingLayer: initialFilter?.missingLayer ?? "",
  });
  const [selected, setSelected] = useState<CapabilityRegistrySummary | null>(
    null,
  );
  const [insights, setInsights] = useState<CapabilityInsights | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => filterCatalog(rows, filter), [rows, filter]);

  function openRow(row: CapabilityRegistrySummary): void {
    setSelected(row);
    setInsights(null);
    setDrawerOpen(true);
    startTransition(async () => {
      const result = await fetchCapabilityInsights(orgSlug, row.name);
      setInsights(result);
    });
  }

  return (
    <div className="flex flex-col gap-4" data-testid="capability-catalog">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={filter.q}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setFilter((f) => ({ ...f, q: e.target.value }))
          }
          placeholder="Search name, domain, description…"
          aria-label="Search capabilities"
          className="w-72 max-w-full"
        />
        <select
          value={filter.domain}
          onChange={(e) => setFilter((f) => ({ ...f, domain: e.target.value }))}
          aria-label="Filter by domain"
          className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground"
        >
          <option value="">All domains</option>
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant={filter.gapOnly ? "default" : "outline"}
          aria-pressed={filter.gapOnly}
          onClick={() => setFilter((f) => ({ ...f, gapOnly: !f.gapOnly }))}
        >
          Surface gaps only
        </Button>
        {filter.missingLayer ? (
          <Badge size="sm" variant="warning-soft">
            missing layer: {filter.missingLayer}
            <button
              type="button"
              className="ml-1 underline"
              aria-label="Clear missing-layer filter"
              onClick={() => setFilter((f) => ({ ...f, missingLayer: "" }))}
            >
              ×
            </button>
          </Badge>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {filtered.length} of {rows.length} contracts
        </span>
      </div>

      {/* Catalog table */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No capabilities match your filters"
          description="Adjust the search text or clear a filter to see the full catalog."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-3 py-2 font-medium">Capability</th>
                <th className="px-3 py-2 font-medium">Domain</th>
                <th className="px-3 py-2 font-medium">Layers</th>
                <th className="px-3 py-2 font-medium">Default access</th>
                <th className="px-3 py-2 font-medium">Terms</th>
                <th className="px-3 py-2 font-medium">Sensitivity</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const gaps = missingCoreLayers(row);
                const roles = allowedOrgRoles(row);
                return (
                  <tr
                    key={row.name}
                    className="cursor-pointer border-b border-border last:border-b-0 hover:bg-muted/30"
                    data-testid={`capability-row-${row.name}`}
                    onClick={() => openRow(row)}
                  >
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="font-mono text-xs text-foreground underline-offset-2 hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          openRow(row);
                        }}
                      >
                        {row.name}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {row.domain}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {row.layers.map((l) => (
                          <Badge key={l} size="sm" variant="muted">
                            {l}
                          </Badge>
                        ))}
                        {hasSurfaceGap(row) ? (
                          <Badge size="sm" variant="warning-soft">
                            missing: {gaps.join(", ")}
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {roles.length > 0 ? roles.join(", ") : row.defaultEffect}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        <Badge
                          size="sm"
                          variant={row.noBillingGate ? "muted" : "info-soft"}
                        >
                          {row.noBillingGate ? "exempt" : "metered"}
                        </Badge>
                        {row.plugin ? (
                          <Badge size="sm" variant="warning-soft">
                            {row.plugin.tier}
                          </Badge>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        size="sm"
                        variant={
                          row.sensitivity === "low"
                            ? "success-soft"
                            : row.sensitivity === "medium"
                              ? "warning-soft"
                              : "error-soft"
                        }
                      >
                        {row.sensitivity}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ContractDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        summary={selected}
        insights={insights}
      />
    </div>
  );
}
