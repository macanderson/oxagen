"use client";
import * as React from "react";
import { resolveRecordHref } from "@oxagen/oxagen/capability-meta";
import { Bot, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * agent-definition-list-card — renders `agent.definition.list` output as a
 * compact, borderless roster of the workspace's agents: one scannable row per
 * agent instead of a generic key/value dump.
 *
 * componentId: "agent-definition-list-card"
 *
 * Mental model: an Agent has versions; an AgentVersion is what gets pinned to an
 * AgentConversation, and the app lets you interact with any active version in
 * your environment. This card lists the *definitions*; the version column shows
 * the latest available version, and the status dot signals whether the agent is
 * live/deployed in this environment.
 *
 * Per row: a status dot, the human Name (slug muted beneath — never the raw id
 * as the primary label), the latest version, and a deep-link to the Workbench
 * agent page. Managed (product built-in, read-only) agents carry a subtle tag.
 */

interface AgentDefinitionListCardProps {
  capability?: string;
  output?: unknown;
  orgSlug?: string;
  workspaceSlug?: string;
}

/**
 * Status-dot state. Blue = active/deployed (okay), grey = disabled
 * (draft/archived/undeployed), green = running (a live execution). The list
 * payload never carries a running state — that is a per-conversation execution
 * signal — so this card resolves only blue vs grey; "running" is kept in the
 * type + palette so a future live-status feed can reuse the same dot.
 */
type DotState = "active" | "disabled" | "running";

interface Row {
  publicId: string;
  name: string;
  slug: string;
  latestVersion: number | null;
  dot: DotState;
  statusLabel: string;
  managed: boolean;
}

// Semantic tokens, not raw Tailwind colors (mirrors activity/span-tree's
// StatusDot): info = blue, success = green, muted-foreground = grey.
const DOT_CLASS: Record<DotState, string> = {
  active: "bg-info",
  running: "bg-success",
  disabled: "bg-muted-foreground",
};

function toRows(output: unknown): Row[] {
  if (typeof output !== "object" || output === null) return [];
  const list = (output as Record<string, unknown>).agents;
  if (!Array.isArray(list)) return [];
  const rows: Row[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const a = raw as Record<string, unknown>;
    if (typeof a.publicId !== "string") continue;
    const deployed = a.deploymentStatus === "active";
    rows.push({
      publicId: a.publicId,
      name:
        typeof a.name === "string" && a.name.length > 0
          ? a.name
          : "Untitled agent",
      slug: typeof a.slug === "string" ? a.slug : "",
      latestVersion:
        typeof a.latestVersion === "number" ? a.latestVersion : null,
      dot: deployed ? "active" : "disabled",
      statusLabel: deployed
        ? "Active"
        : a.status === "archived"
          ? "Archived"
          : a.status === "draft"
            ? "Draft"
            : "Inactive",
      managed: a.managed === true,
    });
  }
  return rows;
}

export default function AgentDefinitionListCard(
  props: AgentDefinitionListCardProps,
): React.ReactElement {
  const rows = toRows(props.output);
  const slugs = { orgSlug: props.orgSlug, workspaceSlug: props.workspaceSlug };

  return (
    <div className="my-2" data-component="agent-definition-list-card">
      <div className="flex items-center gap-2 px-2 pb-1.5">
        <Bot className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-sm font-semibold text-foreground">Agents</span>
        {rows.length > 0 ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {rows.length}
          </span>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">
          No agents in this workspace.
        </p>
      ) : (
        <ul>
          {rows.map((row) => {
            const href = resolveRecordHref("agent", row.publicId, slugs);
            const inner = (
              <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/50">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    DOT_CLASS[row.dot],
                  )}
                  title={row.statusLabel}
                >
                  <span className="sr-only">{row.statusLabel}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium text-foreground"
                    title={row.name}
                  >
                    {row.name}
                  </p>
                  {row.slug ? (
                    <p
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={row.slug}
                    >
                      {row.slug}
                    </p>
                  ) : null}
                </div>
                {row.managed ? (
                  <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Managed
                  </span>
                ) : null}
                <span
                  className="shrink-0 text-xs tabular-nums text-muted-foreground"
                  title="Latest version"
                >
                  {row.latestVersion === null ? "—" : `v${row.latestVersion}`}
                </span>
                {href ? (
                  <ArrowUpRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                ) : null}
              </div>
            );
            return (
              <li key={row.publicId}>
                {href ? (
                  <a
                    href={href}
                    className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {inner}
                  </a>
                ) : (
                  inner
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
