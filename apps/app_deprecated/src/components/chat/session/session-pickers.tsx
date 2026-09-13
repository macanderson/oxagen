"use client";
/**
 * session-pickers.tsx — the shared picker content rendered behind every
 * SessionSettings row: a searchable, groupable list (`SessionPickerList`) plus
 * the model catalog's provider-grouped variant (`ModelPickerRows`). This file
 * only renders LIST CONTENT — the surrounding chrome (a full-screen pushed
 * page on mobile, an anchored Popover on rail/slide-over) is owned by
 * `SessionSettings` so the same content works in both contexts unchanged.
 */
import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchInput } from "@/components/ui/search-input";
import {
  gatewayModels,
  getModel,
  vendorLabels,
  supportsText,
  capabilityLabel,
  TEXT_TIERS,
  type GatewayModel,
  type ResolvedTierCatalog,
  type TextTier,
  type Vendor,
  type Capability,
} from "@oxagen/ai/catalog";

// ---------------------------------------------------------------------------
// Generic searchable, grouped list
// ---------------------------------------------------------------------------

export interface SessionPickerRow {
  id: string;
  label: string;
  sublabel?: string | null;
  /** Extra muted metadata line (e.g. the model list's capability summary). */
  meta?: string | null;
  badge?: React.ReactNode;
  disabled?: boolean;
}

export interface SessionPickerGroup {
  id: string;
  /** Group header — omit (or pass "Recent" for a pinned group) for a flat list. */
  label?: string | null;
  rows: SessionPickerRow[];
}

export interface SessionPickerListProps {
  groups: SessionPickerGroup[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  searchPlaceholder?: string;
  emptyMessage?: string;
  /** Rendered after the (filtered) groups — e.g. the model list's "All providers" row. */
  trailing?: React.ReactNode;
  /** Scroll the selected row into view once on mount (this content remounts fresh every open). */
  autoScrollToSelected?: boolean;
  className?: string;
}

function matchesQuery(row: SessionPickerRow, query: string): boolean {
  if (!query) return true;
  const haystack =
    `${row.label} ${row.sublabel ?? ""} ${row.meta ?? ""}`.toLowerCase();
  return haystack.includes(query.toLowerCase());
}

/**
 * A searchable, optionally-grouped selection list: search input up top, radio-
 * style rows below (selected row gets a checkmark), grouped under an optional
 * label. Used directly for the Code section's org/repo/branch/environment
 * pickers, and wrapped by `ModelPickerRows` for the model picker.
 */
export function SessionPickerList({
  groups,
  selectedId,
  onSelect,
  searchPlaceholder = "Search",
  emptyMessage = "No matches",
  trailing,
  autoScrollToSelected = false,
  className,
}: SessionPickerListProps) {
  const [query, setQuery] = React.useState("");
  const selectedRowRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    // jsdom (unit tests) has no scrollIntoView implementation — guard rather
    // than assume every DOM environment provides it.
    if (
      autoScrollToSelected &&
      typeof selectedRowRef.current?.scrollIntoView === "function"
    ) {
      selectedRowRef.current.scrollIntoView({ block: "nearest" });
    }
    // Mount-only: this content is remounted fresh every time the picker opens
    // (pushed page / popover popup unmount on close), so there is no "later
    // selection changed" case to react to here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredGroups = groups
    .map((g) => ({ ...g, rows: g.rows.filter((r) => matchesQuery(r, query)) }))
    .filter((g) => g.rows.length > 0);

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      <SearchInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery("")}
        placeholder={searchPlaceholder}
        aria-label={searchPlaceholder}
      />
      <div className="flex flex-col gap-1 overflow-y-auto">
        {filteredGroups.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {emptyMessage}
          </p>
        ) : (
          filteredGroups.map((g) => (
            <div key={g.id} role="group" aria-label={g.label ?? undefined}>
              {g.label ? (
                <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {g.label}
                </div>
              ) : null}
              {g.rows.map((row) => {
                const selected = row.id === selectedId;
                return (
                  <button
                    key={row.id}
                    ref={selected ? selectedRowRef : undefined}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={row.disabled}
                    onClick={() => onSelect(row.id)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                      selected && "bg-accent/40",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground">
                        {row.label}
                      </span>
                      {row.sublabel ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.sublabel}
                        </span>
                      ) : null}
                      {row.meta ? (
                        <span className="block truncate text-[11px] text-muted-foreground/80">
                          {row.meta}
                        </span>
                      ) : null}
                    </span>
                    {row.badge}
                    {selected ? (
                      <Check
                        className="size-4 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))
        )}
        {trailing}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model picker: Oxagen tiers + provider-grouped catalog (Anthropic first)
// ---------------------------------------------------------------------------

const CAPABILITY_META_ORDER: Capability[] = ["reasoning", "vision", "tools"];

/** One metadata line: context window · reasoning · vision · tools — omits unknown bits. */
function modelMetaLine(model: GatewayModel): string {
  const parts: string[] = [];
  if (model.context) parts.push(model.context);
  for (const cap of CAPABILITY_META_ORDER) {
    if (model.capabilities.includes(cap)) parts.push(capabilityLabel(cap));
  }
  return parts.join(" · ");
}

// Anthropic first (it backs every Oxagen text tier), then the rest of the
// catalog. A vendor with zero text-capable models (e.g. bfl, pure image/video)
// is dropped by the filter below rather than rendered as an empty group.
const VENDOR_ORDER: Vendor[] = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "meta",
  "mistral",
  "deepseek",
  "bfl",
];

export interface ModelPickerRowsProps {
  modelConfig: ResolvedTierCatalog;
  tier: TextTier | null;
  model: string | null;
  onSelectTier: (tier: TextTier) => void;
  onSelectModel: (id: string) => void;
}

/**
 * The session Model row's picker content: the three white-labeled Oxagen
 * tiers up top, the Anthropic catalog group (Anthropic backs every tier, so it
 * is shown by default), and a trailing "All providers" row that expands the
 * remaining vendor groups inline — mirroring `model-picker.tsx`'s tier-vs-
 * explicit-model split without its menu/flyout chrome.
 */
export function ModelPickerRows({
  modelConfig,
  tier,
  model,
  onSelectTier,
  onSelectModel,
}: ModelPickerRowsProps) {
  const [expanded, setExpanded] = React.useState(false);
  const selectedId = model ?? tier ?? "fast";

  const modelsByVendor = React.useMemo(() => {
    const map = new Map<Vendor, GatewayModel[]>();
    for (const m of gatewayModels) {
      if (!supportsText(m)) continue;
      const list = map.get(m.vendor) ?? [];
      list.push(m);
      map.set(m.vendor, list);
    }
    return map;
  }, []);

  const vendorGroup = React.useCallback(
    (vendor: Vendor): SessionPickerGroup => ({
      id: `vendor:${vendor}`,
      label: vendorLabels[vendor],
      rows: (modelsByVendor.get(vendor) ?? []).map((m) => ({
        id: m.id,
        label: m.name,
        meta: modelMetaLine(m),
      })),
    }),
    [modelsByVendor],
  );

  const tierGroup: SessionPickerGroup = {
    id: "tiers",
    label: "Oxagen",
    rows: TEXT_TIERS.map((t) => {
      const resolvedId = modelConfig.text[t.id];
      const resolved = getModel(resolvedId);
      return {
        id: t.id,
        label: t.name,
        sublabel: t.blurb,
        // Show the raw gateway id only when the catalog can't name it — never
        // render an id as the row's primary label.
        meta: resolved ? undefined : resolvedId,
      };
    }),
  };

  const remainingVendors = VENDOR_ORDER.filter(
    (v) => v !== "anthropic" && (modelsByVendor.get(v)?.length ?? 0) > 0,
  );

  const groups: SessionPickerGroup[] = [
    tierGroup,
    vendorGroup("anthropic"),
    ...(expanded ? remainingVendors.map(vendorGroup) : []),
  ];

  const isTierId = (id: string): id is TextTier =>
    TEXT_TIERS.some((t) => t.id === id);

  return (
    <SessionPickerList
      groups={groups}
      selectedId={selectedId}
      onSelect={(id) => {
        if (isTierId(id)) onSelectTier(id);
        else onSelectModel(id);
      }}
      searchPlaceholder="Search models"
      autoScrollToSelected
      trailing={
        !expanded && remainingVendors.length > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex min-h-11 w-full items-center rounded-md px-2 py-1.5 text-left text-sm font-medium text-primary hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            All providers
          </button>
        ) : null
      }
    />
  );
}
