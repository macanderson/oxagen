/**
 * Oxagen brand marks — the "o + cursor" identity.
 *
 * LOGOMARK: the lowercase "o" letterform beside a terminal cursor block. This
 * is the canonical mark from `docs/brand/logos/svg/` — the geometry here is
 * `oxagen-glyph-adaptive.svg` verbatim (viewBox and path data unchanged), so
 * the rendered component and the shipped asset files cannot drift apart.
 *
 * The "o" is INK and inherits `currentColor`, so it flips with the app theme.
 * The cursor is the brand's own red-orange (--ox-cursor: #FF3D1F light /
 * #FF4B2A dark). That is deliberately NOT the ember accent: the brand asset
 * set defines the cursor in this hue, and the mark is kept faithful to those
 * files rather than recoloured to match the surrounding UI.
 *
 * WORDMARK: "oxagen" — always lowercase — set in Aeonik (weight 660), matching
 * the oxagen.sh lockup; the ink flips between modes via `text-foreground`. The
 * lowercase is enforced in CSS (.ox-wordmark) too.
 *
 *   <OxagenLogomark className="h-7" />           // the o + cursor mark
 *   <OxagenWordmark className="text-xl" />       // "oxagen" wordmark text
 *   <BrandMark />                                // mark at the app-chrome size
 *   <OxagenLockup />                             // mark + wordmark, side by side
 *   <OxagenLogo variant="vertical" size={48} />  // full lockup API
 *   <NodeChip kind="document" id="doc_41be09" /> // typed knowledge-graph node
 *   <ConfidenceBar score={0.82} />               // edge-inference confidence
 *
 * All marks are pure presentational (no hooks) so they render in Server
 * Components.
 */

import type { CSSProperties } from "react";
import { cn } from "../lib/utils";

/**
 * The mark's intrinsic aspect. The glyph is WIDE — an "o" beside a cursor
 * block — not square like the hex-cluster mark it replaces, so callers size it
 * by HEIGHT and let width follow. Forcing it into a square box would letterbox
 * the mark and paint it at ~63% of the height available to it.
 */
const MARK_W = 143;
const MARK_H = 90;
const MARK_ASPECT = MARK_W / MARK_H;

/** The mark's own viewBox, straight from oxagen-glyph-adaptive.svg. */
const MARK_VIEWBOX = "-4.40 -80.00 143.40 90.20";

/** The "o" letterform. */
const O_PATH =
  "M30 1.2Q22.4 1.2 16.7 -2.25Q11 -5.7 7.8 -12Q4.6 -18.3 4.6 -26.8Q4.6 -35.4 7.8 -41.65Q11 -47.9 16.7 -51.35Q22.4 -54.8 30 -54.8Q37.6 -54.8 43.3 -51.35Q49 -47.9 52.2 -41.65Q55.4 -35.4 55.4 -26.8Q55.4 -18.3 52.2 -12Q49 -5.7 43.3 -2.25Q37.6 1.2 30 1.2ZM30 -10.8Q35.4 -10.8 38.35 -14.95Q41.3 -19.1 41.3 -26.8Q41.3 -34.6 38.35 -38.7Q35.4 -42.8 30 -42.8Q24.6 -42.8 21.65 -38.7Q18.7 -34.6 18.7 -26.8Q18.7 -19.1 21.65 -14.95Q24.6 -10.8 30 -10.8Z";

export type LogoTone = "gradient" | "mono-light" | "mono-dark" | "solid";

function monoColor(tone: LogoTone): string | null {
  if (tone === "mono-light") return "var(--ink-light)";
  if (tone === "mono-dark") return "var(--ink-dark)";
  if (tone === "solid") return "currentColor";
  return null; // full colour — ink + brand cursor
}

/** The Oxagen logomark — the "o + cursor" mark. */
export function OxagenLogomark({
  className,
  tone = "gradient",
  style,
}: {
  className?: string;
  tone?: LogoTone;
  style?: CSSProperties;
}) {
  const mono = monoColor(tone);
  const ink = mono ?? "currentColor";
  // A mono tone flattens the whole mark to one colour; otherwise the cursor
  // keeps its brand hue while the "o" tracks the surrounding text colour.
  const cursor = mono ?? "var(--ox-cursor)";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={MARK_VIEWBOX}
      fill="none"
      role="img"
      aria-label="Oxagen logomark"
      className={cn("text-foreground", className)}
      style={style}
    >
      {/* The "o" — ink that flips with the theme (inherits text colour) */}
      <path d={O_PATH} fill={ink} />
      {/* The cursor block — the brand red-orange, or flattened by a mono tone */}
      <rect x="74" y="-71" width="56" height="71" rx="3.4" fill={cursor} />
    </svg>
  );
}

/** The Oxagen wordmark — lowercase "oxagen" text. Ink flips with theme. */
export function OxagenWordmark({
  className,
  tone = "gradient",
  style,
}: {
  className?: string;
  tone?: LogoTone;
  style?: CSSProperties;
}) {
  const mono = monoColor(tone);
  const color = mono && mono !== "currentColor" ? mono : undefined;
  return (
    <span
      className={cn("ox-wordmark inline-block", className)}
      style={color ? { color, ...style } : style}
    >
      oxagen
    </span>
  );
}

/**
 * Brand mark — the o + cursor mark at the app-chrome size. Sized by HEIGHT
 * (`h-7 w-auto`), not `size-7`: the mark is wider than it is tall, so a square
 * box would letterbox it.
 */
export function BrandMark({ className }: { className?: string }) {
  return <OxagenLogomark className={cn("h-7 w-auto shrink-0", className)} />;
}

/** Brand lockup: mark + wordmark, side by side. Wordmark hides on mobile. */
export function OxagenLockup({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <BrandMark />
      <OxagenWordmark className="hidden text-xl text-foreground sm:inline-block" />
    </span>
  );
}

/**
 * Full logo lockup API mirroring the design system.
 *   variant: mark | wordmark | horizontal | vertical
 *   tone:    gradient | mono-light | mono-dark | solid
 *   size:    mark height in px (wordmark scales relative to it)
 */
export function OxagenLogo({
  variant = "horizontal",
  tone = "gradient",
  size = 28,
  className,
}: {
  variant?: "mark" | "wordmark" | "horizontal" | "vertical";
  tone?: LogoTone;
  size?: number;
  className?: string;
}) {
  // `size` is the mark HEIGHT; width follows the mark's own aspect so the
  // glyph is never squashed or letterboxed.
  const markStyle: CSSProperties = { width: size * MARK_ASPECT, height: size };

  if (variant === "mark") {
    return (
      <span
        className={cn("inline-flex", className)}
        style={markStyle}
        aria-label="Oxagen"
      >
        <OxagenLogomark tone={tone} className="size-full" />
      </span>
    );
  }
  if (variant === "wordmark") {
    return (
      <OxagenWordmark
        tone={tone}
        className={cn("text-foreground", className)}
      />
    );
  }
  if (variant === "vertical") {
    return (
      <span
        className={cn("inline-flex flex-col items-center", className)}
        style={{ gap: size * 0.34 }}
        aria-label="Oxagen"
      >
        <OxagenLogomark tone={tone} style={markStyle} className="shrink-0" />
        <OxagenWordmark
          tone={tone}
          style={{ fontSize: size * 0.92 }}
          className="text-foreground"
        />
      </span>
    );
  }
  // horizontal (default)
  return (
    <span
      className={cn("inline-flex items-center", className)}
      style={{ gap: size * 0.42 }}
      aria-label="Oxagen"
    >
      <OxagenLogomark tone={tone} style={markStyle} className="shrink-0" />
      <OxagenWordmark
        tone={tone}
        style={{ fontSize: size * 1.02 }}
        className="text-foreground"
      />
    </span>
  );
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
