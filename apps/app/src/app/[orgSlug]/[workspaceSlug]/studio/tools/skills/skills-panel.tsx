"use client";
/**
 * skills-panel.tsx — Workspace → Studio → Skills list panel.
 *
 * Renders the installed skills table with name, source/provenance, active
 * version, last updated, last used, and usage count, plus a "+ New skill"
 * action that opens the create dialog. Links through to the per-skill
 * detail view. Adapted from settings/skills/skills-panel.tsx (same table),
 * moved under Studio and extended with the create flow.
 */
import * as React from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, Plus, Search, Sparkles } from "lucide-react";
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

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function sourceLabel(source: string): string {
  if (source === "builtin") return "Built-in";
  if (source === "tenant") return "Custom";
  return source;
}

function sourceBadgeVariant(source: string): "default" | "secondary" | "outline" {
  if (source === "builtin") return "secondary";
  if (source === "tenant") return "default";
  return "outline";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SkillsPanel({
  orgSlug,
  workspaceSlug,
  skills,
  canManage,
  createAction,
  draftAction,
}: SkillsPanelProps) {
  const [filter, setFilter] = React.useState("");
  const [newSkillOpen, setNewSkillOpen] = React.useState(false);

  const filtered = React.useMemo(
    () =>
      skills.filter(
        (s) =>
          s.name.toLowerCase().includes(filter.toLowerCase()) ||
          s.slug.toLowerCase().includes(filter.toLowerCase()) ||
          s.description.toLowerCase().includes(filter.toLowerCase()),
      ),
    [skills, filter],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 flex-1 max-w-sm">
          <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden="true" />
          <Input
            placeholder="Search skills..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8"
            aria-label="Search installed skills"
            data-testid="skills-search-input"
          />
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-muted-foreground">
            {filtered.length} skill{filtered.length !== 1 ? "s" : ""}
          </div>
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

      {/* Table */}
      {filtered.length === 0 ? (
        <div
          className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground"
          data-testid="skills-empty-state"
        >
          <Sparkles className="h-8 w-8 opacity-40" aria-hidden="true" />
          <p className="text-sm">
            {filter
              ? "No skills match your search."
              : "No skills installed in this workspace yet."}
          </p>
        </div>
      ) : (
        <div className="rounded-md border bg-card overflow-x-auto" data-testid="skills-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Source</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Version</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Last Updated
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">
                  Last Used
                </th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Uses</th>
                <th className="px-4 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((skill, idx) => (
                <tr
                  key={skill.id}
                  className={`border-b last:border-0 hover:bg-muted/20 transition-colors${idx % 2 === 1 ? " bg-muted/5" : ""}`}
                  data-testid={`skill-row-${skill.slug}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">{skill.name}</span>
                      <span className="text-xs text-muted-foreground font-mono">{skill.slug}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={sourceBadgeVariant(skill.source)}
                      className="text-xs"
                      data-testid={`skill-source-badge-${skill.slug}`}
                    >
                      {sourceLabel(skill.source)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {skill.activeVersion ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {formatDate(skill.updatedAt)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">
                    {formatDate(skill.lastUsedAt)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground text-xs">
                    {skill.usageCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={`Manage ${skill.name}`}
                      data-testid={`skill-detail-link-${skill.slug}`}
                      render={
                        <Link
                          href={`/${orgSlug}/${workspaceSlug}/studio/tools/skills/${encodeURIComponent(skill.slug)}`}
                        />
                      }
                    >
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <div className="rounded-md border overflow-hidden">
        <div className="bg-muted/40 border-b px-4 py-3 flex gap-8">
          {["Name", "Source", "Version", "Last Updated", "Last Used", "Uses"].map((h) => (
            <Skeleton key={h} className="h-4 w-20" />
          ))}
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b last:border-0 flex gap-8 items-center">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-10" />
          </div>
        ))}
      </div>
    </div>
  );
}
