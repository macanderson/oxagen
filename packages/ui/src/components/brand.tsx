/**
 * Oxagen brand marks — jewel-tone identity.
 *
 * LOGOMARK: a thick circle ("O") stroked in the nebula gradient
 * (cyan → violet → cosmos). WORDMARK: "Oxagen" in Aeonik Fono — the ONLY place
 * the display face is used (everything else is Aeonik sans per the type rule).
 *
 *   <OxagenLogomark className="size-7" />        // the gradient ring
 *   <OxagenWordmark className="text-xl" />       // "Oxagen" in Aeonik Fono
 *   <BrandMark />                                // ring at the app-chrome size
 *   <OxagenLockup />                             // ring + wordmark, side by side
 *   <OxagenLogo variant="vertical" size={48} />  // full lockup API
 *   <NodeChip kind="document" id="doc_41be09" /> // typed knowledge-graph node
 *   <ConfidenceBar score={0.82} />               // edge-inference confidence
 *
 * All marks are pure presentational (no hooks) so they render in Server
 * Components. The ring shares a single fixed gradient id — every instance paints
 * the identical nebula gradient, so a shared def is safe and avoids forcing a
 * client boundary with useId().
 */

import type { CSSProperties } from "react";
import { cn } from "../lib/utils";

const NEBULA_ID = "oxagenNebula";

export type LogoTone = "gradient" | "mono-light" | "mono-dark" | "solid";

function monoColor(tone: LogoTone): string | null {
  if (tone === "mono-light") return "#f4f6fb";
  if (tone === "mono-dark") return "#0f0e15";
  if (tone === "solid") return "currentColor";
  return null; // gradient
}

/** The Oxagen logomark — a thick circle stroked in the nebula gradient. */
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
  const stroke = mono ?? `url(#${NEBULA_ID})`;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      fill="none"
      role="img"
      aria-label="Oxagen logomark"
      className={className}
      style={style}
    >
      {!mono && (
        <defs>
          <linearGradient id={NEBULA_ID} x1="10" y1="10" x2="90" y2="90" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#7ce8f4" />
            <stop offset="0.52" stopColor="#7c5aed" />
            <stop offset="1" stopColor="#df2a5d" />
          </linearGradient>
        </defs>
      )}
      <circle cx="50" cy="50" r="37" stroke={stroke} strokeWidth="13" />
    </svg>
  );
}

/** The Oxagen wordmark — "Oxagen" set in Aeonik Fono (the only Fono usage). */
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
      Oxagen
    </span>
  );
}

/** Brand mark — the gradient ring at the app-chrome size. */
export function BrandMark({ className }: { className?: string }) {
  return <OxagenLogomark className={cn("size-7 shrink-0", className)} />;
}

/** Brand lockup: ring + wordmark, side by side. Wordmark hides on mobile. */
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
  // size the ring/wordmark via inline style so callers can pass any px size.
  const ringStyle: CSSProperties = { width: size, height: size };

  if (variant === "mark") {
    return (
      <span className={cn("inline-flex", className)} style={ringStyle} aria-label="Oxagen">
        <OxagenLogomark tone={tone} className="size-full" />
      </span>
    );
  }
  if (variant === "wordmark") {
    return (
      <OxagenWordmark
        tone={tone}
        className={cn("text-foreground", className)}
        // wordmark cap-height ~= ring height
      />
    );
  }
  if (variant === "vertical") {
    return (
      <span className={cn("inline-flex flex-col items-center", className)} style={{ gap: size * 0.34 }} aria-label="Oxagen">
        <OxagenLogomark tone={tone} style={ringStyle} className="shrink-0" />
        <OxagenWordmark tone={tone} style={{ fontSize: size * 0.92 }} className="text-foreground" />
      </span>
    );
  }
  // horizontal (default)
  return (
    <span className={cn("inline-flex items-center", className)} style={{ gap: size * 0.42 }} aria-label="Oxagen">
      <OxagenLogomark tone={tone} style={ringStyle} className="shrink-0" />
      <OxagenWordmark tone={tone} style={{ fontSize: size * 1.02 }} className="text-foreground" />
    </span>
  );
}

/* ── Knowledge-graph brand primitives ──────────────────────────────────────── */

export type NodeKind = "user" | "document" | "service" | "policy" | "resource" | "default";

const NODE_KIND_COLOR: Record<NodeKind, string> = {
  user: "var(--cyan-400)",
  document: "var(--violet-400)",
  service: "#67d182",
  policy: "var(--cosmos-400)",
  resource: "var(--warning)",
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

function confidenceBand(score: number): [track: string, text: string] {
  if (score >= 0.8) return ["#37a04d", "#67d182"];
  if (score >= 0.6) return ["var(--warning)", "#ffbe63"];
  return ["var(--destructive)", "#ff8a6b"];
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
          style={{ width: `${s * 100}%`, background: track, boxShadow: `0 0 8px ${track}` }}
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
