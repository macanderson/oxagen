"use client";
/**
 * structured-value.tsx — the canonical, recursive renderer for tool-call inputs
 * and outputs (and approval/consent previews). It turns an arbitrary JSON-ish
 * value into a typed, scannable key/value tree and NEVER prints raw JSON.
 *
 * Why: dumping `JSON.stringify(value, null, 2)` into a <pre> is unreadable and
 * looks unfinished. Instead every value is rendered by its detected kind:
 *   • objects → a two-column label / value grid (humanized keys)
 *   • arrays  → tag chips (scalars) or stacked indented records (objects)
 *   • ids     → a copy-to-clipboard mono chip (CopyableId)
 *   • status/enum strings → a subtle pill with a tone dot
 *   • dates   → localized with a clock glyph; urls → a link; booleans → ✓/–
 *   • numbers → grouped + tabular
 *
 * The pure classification/format helpers (detectKind, humanizeKey, truncate)
 * and the id chip (CopyableId) are reused from the graph-explorer primitives so
 * "render a value nicely" has exactly one implementation across the app.
 */
import * as React from "react";
import { Check, Clock, Copy, ExternalLink, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { detectKind, humanizeKey, truncate } from "@/components/knowledge/graph-explorer/lib/format";
import { TruncatedText } from "@/components/ui/truncated-text";

/** Serialize a value to JSON for the copy affordance; never throws. Kept local
 *  so this module stays a leaf (no import cycle with the cards that use it). */
function valueToJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export interface StructuredValueProps {
  value: unknown;
  /** The key this value sits under, used as a hint for id detection. */
  keyHint?: string;
  /** Nesting depth (0 = top level); drives indentation of nested records. */
  depth?: number;
}

// ── value classification ────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Prefixed ids: `fan_p48e66…`, `mcs_abc123`, `org_…`. The suffix is captured so
// we can require it to look OPAQUE (see isOpaqueToken) — otherwise plain status
// enums shaped like `in_progress` / `not_started` would be mistaken for ids.
const PREFIXED_ID_RE = /^[a-z][a-z0-9]*_([A-Za-z0-9-]{6,})$/;
// A long opaque token with no whitespace (hashes, tokens, slugs).
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{19,}$/;
// A single short token suitable for a pill (enum/status), no whitespace.
const ENUM_RE = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const KEY_IS_ID_RE = /(^|[_\b])ids?$|Id$|ID$|uuid$/i;

/** An opaque token contains a digit or is long — real ids look random, while a
 *  word like "progress"/"started" does not. */
function isOpaqueToken(token: string): boolean {
  return /[0-9]/.test(token) || token.length >= 12;
}

/** A copyable identifier, by value shape or by an `…Id` key hint. */
export function looksLikeId(value: string, keyHint?: string): boolean {
  if (UUID_RE.test(value)) return true;
  const prefixed = PREFIXED_ID_RE.exec(value);
  if (prefixed && isOpaqueToken(prefixed[1] ?? "")) return true;
  if (keyHint && KEY_IS_ID_RE.test(keyHint) && /^[A-Za-z0-9_-]{6,}$/.test(value)) return true;
  return OPAQUE_TOKEN_RE.test(value);
}

/** A short, single-token string that reads as an enum/status → render as a pill.
 *  (The regex already excludes whitespace and caps length at 24.) */
export function looksLikeEnum(value: string): boolean {
  return ENUM_RE.test(value);
}

/** Tone dot color for known lifecycle/status words; undefined = neutral enum. */
export function statusToneDot(value: string): string | undefined {
  const v = value.toLowerCase();
  if (/^(running|in_progress|processing|streaming|active|live|started|open)$/.test(v)) return "bg-info";
  if (/^(completed|complete|success|succeeded|done|ok|ready|connected|enabled|granted|approved|passed)$/.test(v))
    return "bg-success";
  if (/^(failed|error|errored|cancelled|canceled|denied|expired|disabled|rejected|blocked)$/.test(v))
    return "bg-destructive";
  if (/^(pending|queued|waiting|idle|paused|draft|scheduled|warning)$/.test(v)) return "bg-warning";
  return undefined;
}

function isScalar(value: unknown): boolean {
  const k = detectKind(value);
  return k !== "object" && k !== "array";
}

// ── leaf renderers ──────────────────────────────────────────────────────────

/** A subtle bordered chip — the visual base for enums, tags, and array items.
 *  `title` carries the full (untruncated) value so the CSS `truncate` ellipsis
 *  is always paired with a hover tooltip revealing the complete text. */
function Chip({
  tone,
  title,
  children,
}: {
  tone?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/50 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
      {tone ? <span className={cn("size-1.5 shrink-0 rounded-full", tone)} aria-hidden="true" /> : null}
      <span className="truncate" title={title}>{children}</span>
    </span>
  );
}

function ScalarValue({ value, keyHint }: { value: unknown; keyHint?: string }) {
  const kind = detectKind(value);
  switch (kind) {
    case "null":
      return <span className="text-muted-foreground">—</span>;
    case "boolean":
      return value ? (
        <span className="inline-flex items-center gap-1 text-foreground">
          <Check className="size-3.5 text-success" aria-hidden="true" />
          Yes
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <Minus className="size-3.5" aria-hidden="true" />
          No
        </span>
      );
    case "number":
      return <span className="tabular-nums">{new Intl.NumberFormat().format(value as number)}</span>;
    case "date": {
      const d = new Date(value as string);
      const label = Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
      return (
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3 text-muted-foreground" aria-hidden="true" />
          {label}
        </span>
      );
    }
    case "url":
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline break-all"
        >
          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          {truncate(String(value), 56)}
        </a>
      );
    case "string": {
      const s = value as string;
      if (s.length === 0) return <span className="text-muted-foreground">—</span>;
      if (looksLikeId(s, keyHint)) return <CopyableId value={s} max={24} />;
      if (looksLikeEnum(s)) return <Chip tone={statusToneDot(s)} title={s}>{s}</Chip>;
      // Genuine free text (not an id/enum) — clamp to a few lines with a
      // click-to-reveal popover for the full, formatted content.
      return <TruncatedText text={s} lines={3} />;
    }
    default:
      return null;
  }
}

// ── container renderers ─────────────────────────────────────────────────────

function RecordGrid({ record, depth }: { record: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return <span className="text-xs text-muted-foreground">No fields</span>;
  }
  // Scalar pairs flow two-per-row on wide screens to use horizontal space
  // instead of one tall stack. Container values (nested objects / arrays) span
  // the full row so their trees never get squeezed into a half-width column.
  return (
    <dl className="grid grid-cols-[minmax(5rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 md:grid-cols-[minmax(5rem,max-content)_minmax(0,1fr)_minmax(5rem,max-content)_minmax(0,1fr)]">
      {entries.map(([key, val]) =>
        isScalar(val) ? (
          <React.Fragment key={key}>
            <dt className="truncate pt-px text-xs text-muted-foreground" title={humanizeKey(key)}>
              {humanizeKey(key)}
            </dt>
            <dd className="min-w-0 text-xs text-foreground">
              <StructuredValue value={val} keyHint={key} depth={depth + 1} />
            </dd>
          </React.Fragment>
        ) : (
          <div
            key={key}
            className="col-span-2 grid min-w-0 grid-cols-[minmax(5rem,max-content)_minmax(0,1fr)] gap-x-4 md:col-span-4"
          >
            <dt className="truncate pt-px text-xs text-muted-foreground" title={humanizeKey(key)}>
              {humanizeKey(key)}
            </dt>
            <dd className="min-w-0 text-xs text-foreground">
              <StructuredValue value={val} keyHint={key} depth={depth + 1} />
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}

function ArrayValue({ items, keyHint, depth }: { items: unknown[]; keyHint?: string; depth: number }) {
  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">Empty</span>;
  }
  // Scalar arrays render as a tidy row of chips (tags / ids / enums).
  if (items.every(isScalar)) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {items.map((item, i) => {
          const s = typeof item === "string" ? item : null;
          if (s !== null && looksLikeId(s, keyHint)) return <CopyableId key={i} value={s} max={20} />;
          const label = typeof item === "object" ? "—" : String(item ?? "—");
          return (
            <Chip key={i} tone={s !== null ? statusToneDot(s) : undefined} title={label}>
              {label}
            </Chip>
          );
        })}
      </div>
    );
  }
  // Mixed / object arrays render as stacked, indented, numbered records.
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="border-l-2 border-border/60 pl-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {i + 1}
          </div>
          <StructuredValue value={item} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

export function StructuredValue({ value, keyHint, depth = 0 }: StructuredValueProps) {
  const kind = detectKind(value);
  if (kind === "object") {
    const grid = <RecordGrid record={value as Record<string, unknown>} depth={depth} />;
    // Top level sits flush in the field card; nested records indent under a rule.
    return depth === 0 ? grid : <div className="mt-1 border-l border-border/60 pl-3">{grid}</div>;
  }
  if (kind === "array") {
    return <ArrayValue items={value as unknown[]} keyHint={keyHint} depth={depth} />;
  }
  return <ScalarValue value={value} keyHint={keyHint} />;
}

// ── field wrapper (label + copy + value card) ───────────────────────────────

/** Small ghost button that copies the value as JSON — without ever showing it. */
function CopyJsonButton({ value }: { value: unknown }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(valueToJson(value));
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard unavailable (insecure context) — no-op.
    }
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : "Copy as JSON"}
      aria-label="Copy value as JSON"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? (
        <Check className="size-3 text-success" aria-hidden="true" />
      ) : (
        <Copy className="size-3" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export interface StructuredFieldProps {
  label: string;
  value: unknown;
  /** Show the "Copy as JSON" affordance (default true). */
  copyable?: boolean;
  className?: string;
}

/**
 * A labeled field: uppercase section label + optional copy affordance + the
 * value rendered as a structured tree inside a subtle card. The standard way to
 * present a tool input/result (or an approval/consent preview).
 */
export function StructuredField({ label, value, copyable = true, className }: StructuredFieldProps) {
  return (
    <div className={cn("space-y-1.5", className)} data-testid="structured-field">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
        {copyable && value !== undefined && value !== null ? <CopyJsonButton value={value} /> : null}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
        <StructuredValue value={value} />
      </div>
    </div>
  );
}
