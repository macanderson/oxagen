import * as React from "react";

/**
 * Oxagen logo system.
 *
 * MARK: a simple thick circle outline (the "O") stroked in the nebula gradient
 * (cyan→violet→cosmos). WORDMARK: "Oxagen" in Aeonik Fono (the only place Fono
 * is used). Lockups combine them horizontally or vertically.
 *
 *   variant: "mark" | "wordmark" | "horizontal" | "vertical"
 *   tone:    "gradient"  — nebula ring + currentColor wordmark (full color)
 *            "mono-light"— everything #F4F6FB (for dark backgrounds)
 *            "mono-dark" — everything #0F0E15 (for light backgrounds)
 *            "solid"     — everything currentColor
 *   size = mark height in px.
 */
const NEBULA = ["#7ce8f4", "#7c5aed", "#df2a5d"];

function monoColor(tone) {
  if (tone === "mono-light") return "#f4f6fb";
  if (tone === "mono-dark") return "#0f0e15";
  if (tone === "solid") return "currentColor";
  return null; // gradient
}

function Ring({ size, tone }) {
  const id = React.useId().replace(/:/g, "");
  const mono = monoColor(tone);
  const stroke = mono || `url(#oxneb-${id})`;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-label="Oxagen" style={{ display: "block", flexShrink: 0 }}>
      {!mono && (
        <defs>
          <linearGradient id={`oxneb-${id}`} x1="10" y1="10" x2="90" y2="90" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={NEBULA[0]} />
            <stop offset="0.52" stopColor={NEBULA[1]} />
            <stop offset="1" stopColor={NEBULA[2]} />
          </linearGradient>
        </defs>
      )}
      <circle cx="50" cy="50" r="37" stroke={stroke} strokeWidth="13" />
    </svg>
  );
}

function Wordmark({ size, tone, style }) {
  const mono = monoColor(tone);
  return (
    <span
      className="ox-wordmark"
      style={{
        fontFamily: "var(--font-display)",
        fontWeight: 500,
        letterSpacing: "-0.04em",
        fontSize: size,
        lineHeight: 1,
        color: mono || "currentColor",
        ...style,
      }}
    >
      Oxagen
    </span>
  );
}

export function OxagenLogo({ variant = "horizontal", tone = "gradient", size = 28, style, className, ...props }) {
  if (variant === "mark") {
    return <span className={className} style={{ display: "inline-flex", ...style }} {...props}><Ring size={size} tone={tone} /></span>;
  }
  if (variant === "wordmark") {
    return <span className={className} style={{ display: "inline-flex", ...style }} {...props}><Wordmark size={size} tone={tone} /></span>;
  }
  if (variant === "vertical") {
    return (
      <span className={className} style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: size * 0.34, ...style }} {...props}>
        <Ring size={size} tone={tone} />
        <Wordmark size={size * 0.92} tone={tone} />
      </span>
    );
  }
  // horizontal (default)
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: size * 0.42, ...style }} {...props}>
      <Ring size={size} tone={tone} />
      <Wordmark size={size * 1.02} tone={tone} />
    </span>
  );
}
