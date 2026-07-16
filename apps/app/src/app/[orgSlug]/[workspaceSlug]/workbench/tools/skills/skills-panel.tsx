"use client";
/**
 * skills-panel.tsx — Workspace → Workbench → Skills list panel.
 *
 * Renders the installed skills as a card grid (small/medium cardinality —
 * mobile-friendly cards instead of a table) with client-side search, sort,
 * pagination, and CSV export from the shared list toolkit, plus a
 * "+ New skill" action that opens the create dialog. Links through to the
 * per-skill detail view.
 */
import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import { Download, ExternalLink, Plus, Search, Sparkles } from "lucide-react";
import { CardGrid } from "@/components/lists/card-grid";
import { ListPagination } from "@/components/lists/list-pagination";
import {
  useListControls,
  type ListSortOption,
} from "@/lib/lists/use-list-controls";
import { toCsv, downloadCsv, type CsvColumn } from "@/lib/lists/csv";
import {
  NewSkillDialog,
  type CreateSkillAction,
  type DraftSkillAction,
} from "./new-skill-dialog";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  source: "builtin" | "tenant" | string;
  installedFromSlug: string | null;
  activeVersion: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  usageCount: number;
}

interface SkillsPanelProps {
  orgSlug: string;
  workspaceSlug: string;
  skills: SkillRow[];
  canManage: boolean;
  createAction: CreateSkillAction;
  draftAction: DraftSkillAction;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Workspace-seeded copies of packages/skills templates are stored as
// source="tenant" rows with installed_from_slug provenance — presenting those
// as "Custom" misleads (every fresh workspace would show 14 "Custom" skills
// the user never wrote). Badge template-derived skills as Built-in.
export function effectiveSource(
  row: Pick<SkillRow, "source" | "installedFromSlug">,
): string {
  if (row.source === "builtin" || row.installedFromSlug != null)
    return "builtin";
  return row.source;
}

function sourceLabel(source: string): string {
  if (source === "builtin") return "Built-in";
  if (source === "tenant") return "Custom";
  return source;
}

function sourceBadgeVariant(
  source: string,
): "default" | "secondary" | "outline" {
  if (source === "builtin") return "secondary";
  if (source === "tenant") return "default";
  return "outline";
}

const SORT_OPTIONS: ListSortOption<SkillRow>[] = [
  {
    id: "name",
    label: "Name A–Z",
    compare: (a, b) => (a.name ?? "").localeCompare(b.name ?? ""),
  },
  {
    id: "used",
    label: "Most used",
    compare: (a, b) => b.usageCount - a.usageCount,
  },
  {
    id: "updated",
    label: "Recently updated",
    compare: (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  },
];

const CSV_COLUMNS: CsvColumn[] = [
  { key: "name", header: "Name" },
  { key: "slug", header: "Slug" },
  { key: "source", header: "Source" },
  { key: "activeVersion", header: "Version" },
  { key: "updatedAt", header: "Last updated" },
  { key: "lastUsedAt", header: "Last used" },
  { key: "usageCount", header: "Uses" },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function SkillsPanel({
  orgSlug,
  workspaceSlug,
  skills,
  canManage,
  createAction,
  draftAction,
}: SkillsPanelProps) {
  const [newSkillOpen, setNewSkillOpen] = React.useState(false);

  // Null-safe search keys: a single row with a missing name/slug/description
  // must never throw and blank the entire list (the original bug did exactly
  // that when the list contract omitted slug — see this route's page.tsx notes).
  const controls = useListControls(skills, {
    searchKeys: [
      (s) => s.name ?? "",
      (s) => s.slug ?? "",
      (s) => s.description ?? "",
    ],
    sortOptions: SORT_OPTIONS,
    pageSize: 12,
  });

  return (
    <div className="flex flex-col gap-6">
      {/* Header: search + count + export + create */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-1 max-w-sm min-w-56">
          <Search
            className="h-4 w-4 text-muted-foreground flex-shrink-0"
            aria-hidden="true"
          />
          <Input
            type="search"
            placeholder="Search skills..."
            value={controls.query}
            onChange={(e) => controls.setQuery(e.target.value)}
            className="h-8"
            aria-label="Search installed skills"
            data-testid="skills-search-input"
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            {controls.filteredTotal} skill
            {controls.filteredTotal !== 1 ? "s" : ""}
          </div>
          <Button
            variant="outline"
            size="sm"
            startIcon={<Download className="h-3.5 w-3.5" aria-hidden="true" />}
            onClick={() =>
              downloadCsv(
                "skills.csv",
                toCsv(
                  CSV_COLUMNS,
                  controls.allFilteredRows as unknown as Record<
                    string,
                    unknown
                  >[],
                ),
              )
            }
          >
            Export
          </Button>
          {canManage && (
            <Button
              size="sm"
              onClick={() => setNewSkillOpen(true)}
              data-testid="new-skill-btn"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              New skill
            </Button>
          )}
        </div>
      </div>

      {/* Card grid */}
      {controls.filteredTotal === 0 ? (
        <div
          className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground"
          data-testid="skills-empty-state"
        >
          <Sparkles className="h-8 w-8 opacity-40" aria-hidden="true" />
          <p className="text-sm">
            {controls.query
              ? "No skills match your search."
              : "No skills installed in this workspace yet."}
          </p>
        </div>
      ) : (
        <>
          <CardGrid data-testid="skills-grid">
            {controls.pageRows.map((skill) => (
              <article
                key={skill.id}
                className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                data-testid={`skill-row-${skill.slug}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      {skill.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground font-mono">
                      {skill.slug}
                    </span>
                  </div>
                  <Badge
                    variant={sourceBadgeVariant(effectiveSource(skill))}
                    className="text-xs shrink-0"
                    data-testid={`skill-source-badge-${skill.slug}`}
                  >
                    {sourceLabel(effectiveSource(skill))}
                  </Badge>
                </div>
                {skill.description ? (
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    {skill.description}
                  </p>
                ) : null}
                <dl className="mt-auto grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
                  <div className="flex justify-between gap-2">
                    <dt>Version</dt>
                    <dd className="font-mono">{skill.activeVersion ?? "—"}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Uses</dt>
                    <dd className="tabular-nums">
                      {skill.usageCount.toLocaleString()}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Updated</dt>
                    <dd>{formatDate(skill.updatedAt)}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>Last used</dt>
                    <dd>{formatDate(skill.lastUsedAt)}</dd>
                  </div>
                </dl>
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    aria-label={`Manage ${skill.name}`}
                    data-testid={`skill-detail-link-${skill.slug}`}
                    endIcon={
                      <ExternalLink
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    }
                    render={
                      <Link
                        href={`/${orgSlug}/${workspaceSlug}/workbench/tools/skills/${encodeURIComponent(skill.slug)}`}
                      />
                    }
                  >
                    Manage
                  </Button>
                </div>
              </article>
            ))}
          </CardGrid>
          <ListPagination
            page={controls.page}
            pageCount={controls.pageCount}
            onPageChange={controls.setPage}
            className="self-end"
          />
        </>
      )}

      {canManage && (
        <NewSkillDialog
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          action={createAction}
          draftAction={draftAction}
          open={newSkillOpen}
          onOpenChange={setNewSkillOpen}
        />
      )}
    </div>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

export function SkillsPanelSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 h-8 max-w-sm">
        <Skeleton className="h-8 w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-3 rounded-lg border bg-card p-4"
          >
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
