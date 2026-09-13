"use client";

/**
 * RationalePicker — optional rationale field shared by every promote/demote
 * flow (queue confirm flow, detail-sheet promote/demote, candidates panel).
 * Rationale is optional on promote_memory/demote_memory, so this exists only
 * to remove typing friction: it fetches model-drafted suggestions via
 * suggest_promotion_rationales and offers them in a Select (plus "No
 * rationale" and "Write my own…"), falling back to a plain Textarea when
 * suggestions are unavailable — never a blocking failure, since the rationale
 * itself was never required.
 */

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

export type PromotionRationaleClass = "RULE" | "FACT" | "OBSERVATION";

export type SuggestRationalesFn = (input: {
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  toClass: PromotionRationaleClass;
  count?: number;
}) => Promise<
  { ok: true; rationales: string[] } | { ok: false; error: string }
>;

const NONE = "__none__";
const CUSTOM = "__custom__";

export interface RationalePickerProps {
  /** Unique per rendered instance — used to derive the field's id. */
  idPrefix: string;
  orgSlug: string;
  workspaceSlug: string;
  memoryId: string;
  toClass: PromotionRationaleClass;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /**
   * When absent, the picker skips the suggestion fetch entirely and renders
   * the plain Textarea immediately — the caller opted out of suggestions.
   */
  suggestRationales?: SuggestRationalesFn;
}

export function RationalePicker({
  idPrefix,
  orgSlug,
  workspaceSlug,
  memoryId,
  toClass,
  value,
  onChange,
  disabled,
  suggestRationales,
}: RationalePickerProps) {
  const [status, setStatus] = React.useState<"loading" | "ready" | "degraded">(
    suggestRationales ? "loading" : "degraded",
  );
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  // Once the user asks to write their own (or suggestions never load), the
  // picker commits to the plain textarea for the rest of this flow.
  const [customMode, setCustomMode] = React.useState(false);

  React.useEffect(() => {
    if (!suggestRationales) return;
    let cancelled = false;
    setStatus("loading");
    void suggestRationales({ orgSlug, workspaceSlug, memoryId, toClass })
      .then((result) => {
        if (cancelled) return;
        if (result.ok && result.rationales.length > 0) {
          setSuggestions(result.rationales);
          setStatus("ready");
        } else {
          setStatus("degraded");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("degraded");
      });
    return () => {
      cancelled = true;
    };
  }, [suggestRationales, orgSlug, workspaceSlug, memoryId, toClass]);

  const fieldId = `${idPrefix}-rationale`;
  const label = (
    <label htmlFor={fieldId} className="text-[11px] text-muted-foreground">
      Rationale
    </label>
  );

  if (status === "loading") {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <Skeleton className="h-7 w-full rounded-md" />
      </div>
    );
  }

  if (status === "degraded" || customMode) {
    return (
      <div className="flex flex-col gap-1.5">
        {label}
        <Textarea
          id={fieldId}
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          maxLength={1000}
          placeholder="Why is this memory ready to promote? (optional)"
        />
      </div>
    );
  }

  const selectValue = suggestions.includes(value) ? value : NONE;

  return (
    <div className="flex flex-col gap-1.5">
      {label}
      <Select
        value={selectValue}
        onValueChange={(val) => {
          if (!val || val === NONE) {
            onChange("");
            return;
          }
          if (val === CUSTOM) {
            setCustomMode(true);
            onChange("");
            return;
          }
          onChange(val);
        }}
        disabled={disabled}
      >
        <SelectTrigger id={fieldId} size="sm">
          <SelectValue>
            {selectValue === NONE ? "No rationale" : selectValue}
          </SelectValue>
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectItem value={NONE}>No rationale</SelectItem>
          {suggestions.map((s, i) => (
            <SelectItem key={`${idPrefix}-sugg-${i}`} value={s}>
              {s}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Write my own…</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
