"use client";
import * as React from "react";
import { resolveRecordHref } from "@oxagen/oxagen/capability-meta";
import { MessageSquare, ArrowUpRight, Archive } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * conversation-list-card — renders conversation.list output as a list of
 * conversations, each deep-linked to /[org]/[ws]/chat/[publicId].
 *
 * componentId: "conversation-list-card"
 */

interface ConversationListCardProps {
  capability?: string;
  output?: unknown;
  orgSlug?: string;
  workspaceSlug?: string;
}

interface Row {
  publicId: string;
  title: string;
  archived: boolean;
  updatedAt?: string;
}

function readRows(output: unknown): Row[] {
  if (typeof output !== "object" || output === null) return [];
  const o = output as Record<string, unknown>;
  const list = Array.isArray(o.conversations) ? o.conversations : [];
  const rows: Row[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.publicId !== "string") continue;
    rows.push({
      publicId: c.publicId,
      title:
        typeof c.title === "string" && c.title.length > 0
          ? c.title
          : "Untitled conversation",
      archived: typeof c.archivedAt === "string" && c.archivedAt.length > 0,
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : undefined,
    });
  }
  return rows;
}

function formatWhen(iso?: string): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function ConversationListCard(
  props: ConversationListCardProps,
): React.ReactElement {
  const rows = readRows(props.output);
  const slugs = { orgSlug: props.orgSlug, workspaceSlug: props.workspaceSlug };

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="conversation-list-card"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <MessageSquare
          className="size-4 shrink-0 text-primary"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold">
          {rows.length} conversation{rows.length === 1 ? "" : "s"}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No conversations.
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {rows.map((row) => {
            const href = resolveRecordHref("conversation", row.publicId, slugs);
            const when = formatWhen(row.updatedAt);
            const inner = (
              <div className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={row.title}>
                    {row.title}
                  </p>
                </div>
                {row.archived ? (
                  <Archive
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label="Archived"
                  />
                ) : null}
                {when ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {when}
                  </span>
                ) : null}
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
                    className={cn(
                      "block hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    )}
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
