/**
 * The Oxagen and Stella marks.
 *
 * Geometry comes from `./brand-marks.generated.ts`, extracted by
 * `tools/scripts/sync-brand-assets.mjs` from the house brand kit
 * (macanderson/oxagen-house-brand). Nothing here is drawn: both wordmarks are
 * Space Grotesk's own outlines at weight 600, and both icons are the same face
 * at display weight, so the marks and the product's running text cannot drift
 * apart. To change a mark, change the kit and re-run the sync.
 *
 *   <OxagenWordmark className="h-7" />   // "oxagen", the x in gold — THE logo
 *   <OxagenIcon className="size-7" />    // the one-colour "Ox" lettermark
 *   <StellaWordmark className="h-7" />   // "stella*", the asterisk in gold
 *   <StellaIcon className="size-7" />    // the asterisk alone, in gold
 *   <BrandMark />                        // OxagenIcon at the app-chrome size
 *   <NodeChip kind="document" id="…" />  // typed knowledge-graph node
 *   <ConfidenceBar score={0.82} />       // edge-inference confidence
 *
 * ── THE RULES THESE COMPONENTS ENCODE ────────────────────────────────────────
 *
 * OXAGEN'S LOGO IS THE WORDMARK. There is deliberately no Oxagen lockup export
 * and no horizontal/vertical composition helper. The kit does emit a lockup —
 * the Ox mark in a plate, a gap, then the word — and it is not used in the
 * product: set plainly, `Ox oxagen` stutters, because the mark is the word's
 * own first two letters at the word's own size. Use the wordmark; use the icon
 * only where the slot is square and small (a favicon, an avatar, collapsed
 * chrome), and then use it ALONE, never beside the word.
 *
 * STELLA'S MARK IS INSIDE ITS WORD. `stella*` already carries the asterisk, so
 * the wordmark IS the Stella lockup and nothing is ever placed to its left.
 *
 * ONE GLYPH IS GOLD. The `x` of oxagen, the asterisk of stella — never a second
 * one, never the whole word. The gold stays #D6962C in BOTH themes: the kit's
 * "gold becomes its deep shade on paper" rule governs gold WORDS, not the mark,
 * and the kit's own light and dark files both fill the accent with the metal.
 *
 * THE ICON IS ONE COLOUR. It takes the colour of whatever it sits on, so it can
 * be placed and forgotten — and handed to an operating system that will tint it
 * however it likes. It never carries the metal. StellaIcon is the exception the
 * kit itself makes: the asterisk IS the metal, so it ships gold.
 *
 * MINIMUM SIZES. 88px for a wordmark, 24px for an icon. Below that, use the
 * favicon asset instead of shrinking a mark past legibility.
 *
 * All marks are pure presentational (no hooks) so they render in Server
 * Components.
 */

import type { CSSProperties } from "react";
import { cn } from "../lib/utils";
import {
  BRAND_GOLD,
  OXAGEN,
  STELLA,
  type BrandGeometry,
} from "./brand-marks.generated";

/**
 * How a mark is coloured.
 *
 * `adaptive`  letters inherit currentColor and flip with the theme; the accent
 *             glyph keeps the metal. This is the default and what almost every
 *             surface wants.
 * `mono`      the whole mark, accent included, collapses to currentColor. For
 *             single-colour contexts: a print sheet, an embossed favicon, a
 *             partner's one-colour lockup slot, a disabled state.
 */
export type LogoTone = "adaptive" | "mono";

/** A wordmark: two paths, one of which is the single gold glyph. */
function Wordmark({
  geometry,
  label,
  tone,
  className,
  style,
}: {
  geometry: BrandGeometry;
  label: string;
  tone: LogoTone;
  className?: string;
  style?: CSSProperties;
}) {
  const { viewBox, letters, accent } = geometry.wordmark;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      fill="none"
      role="img"
      aria-label={label}
      // Sized by HEIGHT — a wordmark is much wider than it is tall, and a
      // square box would letterbox it to a fraction of the space it was given.
      className={cn("h-7 w-auto", className)}
      style={style}
    >
      <path d={letters} fill="currentColor" />
      <path d={accent} fill={tone === "mono" ? "currentColor" : BRAND_GOLD} />
    </svg>
  );
}

/** An icon: one path, one colour, inside the kit's own 96-unit box. */
function Icon({
  geometry,
  label,
  fill,
  className,
  style,
}: {
  geometry: BrandGeometry;
  label: string;
  fill: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { viewBox, transform, path } = geometry.icon;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      fill="none"
      role="img"
      aria-label={label}
      className={cn("size-7", className)}
      style={style}
    >
      <g transform={transform}>
        <path d={path} fill={fill} />
      </g>
    </svg>
  );
}

/**
 * THE Oxagen logo — "oxagen", lowercase, its `x` in gold. Use this everywhere a
 * surface identifies itself as Oxagen. There is no lockup alternative.
 */
export function OxagenWordmark({
  className,
  tone = "adaptive",
  style,
}: {
  className?: string;
  tone?: LogoTone;
  style?: CSSProperties;
}) {
  return (
    <Wordmark
      geometry={OXAGEN}
      label="oxagen"
      tone={tone}
      className={cn("text-foreground", className)}
      style={style}
    />
  );
}

/**
 * The Oxagen icon — `Ox`, the word's own first two letters, one colour, taken
 * from whatever it sits on. Square slots only, and always alone: putting it
 * beside the wordmark rebuilds the lockup the product does not use.
 */
export function OxagenIcon({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <Icon
      geometry={OXAGEN}
      label="Oxagen"
      fill="currentColor"
      className={cn("text-foreground", className)}
      style={style}
    />
  );
}

/**
 * The Stella logo — `stella*`. The asterisk is the mark, and it is already in
 * the word, so nothing is ever placed to its left. This is Stella's lockup.
 */
export function StellaWordmark({
  className,
  tone = "adaptive",
  style,
}: {
  className?: string;
  tone?: LogoTone;
  style?: CSSProperties;
}) {
  return (
    <Wordmark
      geometry={STELLA}
      label="stella"
      tone={tone}
      className={cn("text-foreground", className)}
      style={style}
    />
  );
}

/**
 * The Stella icon — the asterisk alone. Unlike the Ox lettermark this one IS
 * the metal: the kit ships it gold, because a lone asterisk in ink reads as
 * punctuation rather than a mark. `tone="mono"` flattens it for one-colour
 * contexts.
 */
export function StellaIcon({
  className,
  tone = "adaptive",
  style,
}: {
  className?: string;
  tone?: LogoTone;
  style?: CSSProperties;
}) {
  return (
    <Icon
      geometry={STELLA}
      label="Stella"
      fill={tone === "mono" ? "currentColor" : BRAND_GOLD}
      className={className}
      style={style}
    />
  );
}

/**
 * The Oxagen icon at the app-chrome size — collapsed sidebars, tab strips,
 * anywhere a square slot names the product. Alone: see OxagenIcon.
 */
export function BrandMark({ className }: { className?: string }) {
  return <OxagenIcon className={cn("size-7 shrink-0", className)} />;
}

/* ── Knowledge-graph brand primitives ──────────────────────────────────────── */

export type NodeKind =
  | "user"
  | "document"
  | "service"
  | "policy"
  | "resource"
  | "default";

// Categorical node palette — the knowledge-graph entity classes read the
// theme's data-viz ramp (--chart-1..5) so they re-skin with the rest of the
// system and never drift to a dead palette. These are VALUE tokens (resolvable
// in inline styles); @theme inline does not emit the --color-* forms to :root.
const NODE_KIND_COLOR: Record<NodeKind, string> = {
  user: "var(--chart-1)",
  document: "var(--chart-2)",
  service: "var(--chart-3)",
  policy: "var(--chart-4)",
  resource: "var(--chart-5)",
  default: "var(--muted-foreground)",
};

/**
 * NodeChip — a typed knowledge-graph node reference: a colour-coded dot + mono
 * entity id, the way the product renders entities in edge diagrams and tool
 * output. `kind` colours the dot by entity class.
 */
export function NodeChip({
  kind = "default",
  id,
  label,
  className,
}: {
  kind?: NodeKind;
  id?: string;
  label?: string;
  className?: string;
}) {
  const color = NODE_KIND_COLOR[kind] ?? NODE_KIND_COLOR.default;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-card py-0.5 pl-2 pr-2.5 font-mono text-[11px] text-foreground",
        className,
      )}
    >
      <span
        className="size-[7px] shrink-0 rounded-full"
        style={{ background: color, boxShadow: `0 0 6px ${color}` }}
      />
      {label && <span className="font-sans font-medium">{label}</span>}
      {id && <span className="tracking-wide text-muted-foreground">{id}</span>}
    </span>
  );
}

// Confidence thresholds map to the semantic status tokens (theme-driven, no
// hardcoded hexes): ≥0.8 success · ≥0.6 warning · else destructive.
function confidenceBand(score: number): [track: string, text: string] {
  if (score >= 0.8) return ["var(--success)", "var(--success)"];
  if (score >= 0.6) return ["var(--warning)", "var(--warning)"];
  return ["var(--destructive)", "var(--destructive)"];
}

/**
 * ConfidenceBar — inference-confidence meter for semantic edges. Colour follows
 * the product thresholds: ≥0.8 success, ≥0.6 warning, else danger.
 */
export function ConfidenceBar({
  score = 0,
  showValue = true,
  width = 120,
  className,
}: {
  score?: number;
  showValue?: boolean;
  width?: number;
  className?: string;
}) {
  const s = Math.max(0, Math.min(1, score));
  const [track, text] = confidenceBand(s);
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span
        className="relative h-1.5 shrink-0 overflow-hidden rounded-full bg-muted"
        style={{ width }}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{
            width: `${s * 100}%`,
            background: track,
            boxShadow: `0 0 8px ${track}`,
          }}
        />
      </span>
      {showValue && (
        <span
          className="font-sans text-[11px] font-semibold tabular-nums"
          style={{ color: text }}
        >
          {Math.round(s * 100)}%
        </span>
      )}
    </span>
  );
}
