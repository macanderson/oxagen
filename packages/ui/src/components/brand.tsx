/**
 * Oxagen brand marks — ember hex-cluster identity.
 *
 * LOGOMARK: six interlocking hexagon cells. Four are ink outlines that flip with
 * the theme (they inherit the current text colour); two are lit with the ember
 * gradient (gold → flame → crimson). The gradient is canonical and holds in both
 * light and dark modes — never recolour it. WORDMARK: "oxagen" — always
 * lowercase — set in Space Grotesk (weight 600); the ink flips between modes via
 * `text-foreground`. The lowercase is enforced in CSS (.ox-wordmark) too.
 *
 *   <OxagenLogomark className="size-7" />        // the hex-cluster mark
 *   <OxagenWordmark className="text-xl" />       // "Oxagen" wordmark text
 *   <BrandMark />                                // mark at the app-chrome size
 *   <OxagenLockup />                             // mark + wordmark, side by side
 *   <OxagenLogo variant="vertical" size={48} />  // full lockup API
 *   <NodeChip kind="document" id="doc_41be09" /> // typed knowledge-graph node
 *   <ConfidenceBar score={0.82} />               // edge-inference confidence
 *
 * All marks are pure presentational (no hooks) so they render in Server
 * Components. The two ember gradients use fixed ids — every instance paints the
 * identical gradient, so shared defs are safe.
 */

import type { CSSProperties } from "react";
import { cn } from "../lib/utils";

const EMBER_ID = "oxagenEmber";
const EMBER_ID_2 = "oxagenEmber2";

export type LogoTone = "gradient" | "mono-light" | "mono-dark" | "solid";

function monoColor(tone: LogoTone): string | null {
  if (tone === "mono-light") return "var(--ink-light)";
  if (tone === "mono-dark") return "var(--ink-dark)";
  if (tone === "solid") return "currentColor";
  return null; // gradient
}

/** The Oxagen logomark — the ember hex-cluster mark. */
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
  const ember1 = mono ?? `url(#${EMBER_ID})`;
  const ember2 = mono ?? `url(#${EMBER_ID_2})`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="7.775 4.325 36.343 37.216"
      fill="none"
      role="img"
      aria-label="Oxagen logomark"
      className={cn("text-foreground", className)}
      style={style}
    >
      {!mono && (
        <defs>
          <linearGradient
            id={EMBER_ID}
            gradientUnits="userSpaceOnUse"
            gradientTransform="matrix(27.9194 19.5129 -21.9367 24.8347 12.2858 18.2731)"
            x1="0"
            y1="0"
            x2="1"
            y2="0"
          >
            <stop offset="0" stopColor="#F9D423" />
            <stop offset=".5" stopColor="#FF7E5F" />
            <stop offset="1" stopColor="#C2185B" />
          </linearGradient>
          <linearGradient
            id={EMBER_ID_2}
            gradientUnits="userSpaceOnUse"
            gradientTransform="matrix(12.59 0 0 12.59 9.77471 32.9406)"
            x1="0"
            y1="0"
            x2="1"
            y2="0"
          >
            <stop offset="0" stopColor="#F9D423" />
            <stop offset=".5" stopColor="#FF7E5F" />
            <stop offset="1" stopColor="#C2185B" />
          </linearGradient>
        </defs>
      )}
      {/* Outline cells — ink that flips with the theme (inherits text colour) */}
      <g fill="none" stroke={ink} strokeWidth="1" strokeLinejoin="miter">
        <path d="M16.1893 6.32478L21.9857 9.3639L21.9857 15.4418L16.1893 18.4806L10.3929 15.4418L10.3929 9.3639L16.1893 6.32478Z" />
        <path d="M29.2662 6.32478L35.0626 9.3639L35.0626 15.4418L29.2662 18.4806L23.4698 15.4418L23.4698 9.3639L29.2662 6.32478Z" />
        <path d="M22.6376 16.5647L28.4341 19.6038L28.4341 25.6814L22.6376 28.7205L16.8412 25.6814L16.8412 19.6038L22.6376 16.5647Z" />
        <path d="M29.2662 26.8043L35.0626 29.8431L35.0626 35.921L29.2662 38.9601L23.4698 35.921L23.4698 29.8431L29.2662 26.8043Z" />
      </g>
      {/* Ember cells — the gradient accent, canonical in both modes */}
      <path
        d="M35.8698 16.2903L42.1182 19.4993L42.1182 25.9165L35.8698 29.1255L29.6214 25.9165L29.6214 19.4993L35.8698 16.2903Z"
        fill={ember1}
      />
      <path
        d="M16.0697 26.3399L22.3647 29.6401L22.3647 36.2408L16.0697 39.5413L9.77471 36.2408L9.77471 29.6401L16.0697 26.3399Z"
        fill={ember2}
        opacity=".55"
      />
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

/** Brand mark — the ember hex-cluster mark at the app-chrome size. */
export function BrandMark({ className }: { className?: string }) {
  return <OxagenLogomark className={cn("size-7 shrink-0", className)} />;
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
  const ringStyle: CSSProperties = { width: size, height: size };

  if (variant === "mark") {
    return (
      <span
        className={cn("inline-flex", className)}
        style={ringStyle}
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
        <OxagenLogomark tone={tone} style={ringStyle} className="shrink-0" />
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
      <OxagenLogomark tone={tone} style={ringStyle} className="shrink-0" />
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
