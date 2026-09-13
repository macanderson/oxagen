"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { X } from "lucide-react";
import type { ChatMention } from "@oxagen/ai/mentions";
import { mentionTypeInfo } from "@oxagen/ai/mentions";
import { Popover, PopoverTrigger, PopoverPopup } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CopyableId } from "../../knowledge/graph-explorer/copyable-id";
import { PropertyList } from "../../knowledge/graph-explorer/property-list";
import { truncate } from "../../knowledge/graph-explorer/lib/format";
import { MENTION_TYPE_META, type MentionSearchResult } from "./mention-meta";

/**
 * mention-chip.tsx — the canonical way to show an @-mention reference.
 *
 * RULE (same as node-ref.tsx): a reference is never shown by its raw slug. It
 * renders as a type icon + human label, and is hover/focus/click inspectable —
 * the popover reveals the reference type, location, copyable slug, and the
 * property bag. Properties not already known (transcript chips reconstruct
 * mentions from tokens, which carry no bag) are hydrated lazily on first open
 * via /api/reference-search's exact-slug resolve mode.
 */

type HydrationState =
  | { status: "idle" | "loading" | "error" }
  | {
      status: "done";
      properties: Record<string, unknown>;
      description: string | null;
    };

export interface MentionChipProps {
  mention: ChatMention;
  /** Known property bag (composer strip passes the picked search row's). */
  properties?: Record<string, unknown> | null;
  description?: string | null;
  /** Renders a remove affordance next to the chip (composer strip). */
  onRemove?: () => void;
  className?: string;
}

export function MentionChip({
  mention,
  properties = null,
  description = null,
  onRemove,
  className,
}: MentionChipProps) {
  const params = useParams<{ orgSlug?: string; workspaceSlug?: string }>();
  const typeInfo = mentionTypeInfo(mention.type);
  const meta = MENTION_TYPE_META[mention.type];
  const Icon = meta.icon;

  const [hydration, setHydration] = React.useState<HydrationState>({
    status: "idle",
  });

  const orgSlug = typeof params?.orgSlug === "string" ? params.orgSlug : null;
  const workspaceSlug =
    typeof params?.workspaceSlug === "string" ? params.workspaceSlug : null;
  const canHydrate =
    properties === null && orgSlug !== null && workspaceSlug !== null;

  // Recreated every render, so it closes over the CURRENT hydration state —
  // no ref needed (and writing a ref during render violates react-hooks/refs).
  const handleOpenChange = (open: boolean) => {
    if (!open || !canHydrate || hydration.status !== "idle") return;
    setHydration({ status: "loading" });
    void (async () => {
      try {
        const res = await fetch("/api/reference-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orgSlug,
            workspaceSlug,
            slug: mention.slug,
            types: [mention.type],
            limit: 1,
          }),
        });
        if (!res.ok) throw new Error(`resolve failed (${res.status})`);
        const json = (await res.json()) as { results?: MentionSearchResult[] };
        const row = json.results?.[0];
        setHydration(
          row
            ? {
                status: "done",
                properties: row.properties,
                description: row.description,
              }
            : { status: "error" },
        );
      } catch {
        setHydration({ status: "error" });
      }
    })();
  };

  const resolvedProperties =
    properties ?? (hydration.status === "done" ? hydration.properties : null);
  const resolvedDescription =
    description ?? (hydration.status === "done" ? hydration.description : null);

  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center align-middle",
        className,
      )}
    >
      <Popover onOpenChange={handleOpenChange}>
        <PopoverTrigger
          openOnHover
          delay={120}
          closeDelay={120}
          className={cn(
            "inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-left align-middle",
            "transition-colors hover:border-border hover:bg-muted/70",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          )}
          aria-label={`Inspect ${typeInfo.label} ${mention.label}`}
          data-testid={`mention-chip-${mention.type}`}
        >
          <Icon
            className={cn("size-3.5 shrink-0", meta.iconClassName)}
            aria-hidden="true"
          />
          <span className="truncate text-sm font-medium text-foreground">
            {truncate(mention.label, 40)}
          </span>
        </PopoverTrigger>
        <PopoverPopup
          side="bottom"
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)] overflow-hidden p-0"
        >
          <div className="flex items-start gap-2 border-b border-border/60 px-3 py-2.5">
            <Icon
              className={cn("mt-0.5 size-4 shrink-0", meta.iconClassName)}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <Badge variant="outline" size="sm">
                {typeInfo.label}
              </Badge>
              <p className="mt-1 break-words text-sm font-semibold text-foreground">
                {mention.label}
              </p>
              {resolvedDescription ? (
                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                  {resolvedDescription}
                </p>
              ) : null}
              {mention.location ? (
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                  {mention.location}
                </p>
              ) : null}
              <div className="mt-1.5">
                <CopyableId value={mention.slug} label="ID" max={24} />
              </div>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto px-3 py-2.5">
            {resolvedProperties &&
            Object.keys(resolvedProperties).length > 0 ? (
              <PropertyList properties={resolvedProperties} dense />
            ) : hydration.status === "loading" ? (
              <p className="text-xs text-muted-foreground">
                Loading properties…
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {typeInfo.summary}
              </p>
            )}
          </div>
        </PopoverPopup>
      </Popover>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          // Keep the textarea focused (and the composer state intact) when
          // removing a chip, same trick as the picker menu items.
          onMouseDown={(e) => e.preventDefault()}
          className="ml-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label={`Remove mention ${mention.label}`}
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}
