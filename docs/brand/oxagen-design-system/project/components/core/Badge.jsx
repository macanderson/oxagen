import * as React from "react";

/**
 * Oxagen Badge — compact status/label pill.
 * Variants cover neutral, brand, and the semantic + risk signals the product
 * uses heavily (low/medium/high risk on agent tool calls).
 */
function tones(variant) {
  const map = {
    default: ["color-mix(in oklch, var(--violet-500) 18%, transparent)", "var(--violet-bright, #9b7bff)", "color-mix(in oklch, var(--violet-500) 40%, transparent)"],
    neutral: ["var(--muted)", "var(--muted-foreground)", "var(--border)"],
    brand: ["color-mix(in oklch, var(--brand) 16%, transparent)", "var(--violet-bright, #9b7bff)", "color-mix(in oklch, var(--brand) 38%, transparent)"],
    cyan: ["color-mix(in oklch, var(--cyan-400) 16%, transparent)", "var(--cyan-300)", "color-mix(in oklch, var(--cyan-400) 40%, transparent)"],
    info: ["color-mix(in oklch, var(--info) 18%, transparent)", "#7fb4f0", "color-mix(in oklch, var(--info) 42%, transparent)"],
    success: ["color-mix(in oklch, var(--success) 20%, transparent)", "#67d182", "color-mix(in oklch, var(--success) 44%, transparent)"],
    warning: ["color-mix(in oklch, var(--warning) 22%, transparent)", "#ffbe63", "color-mix(in oklch, var(--warning) 46%, transparent)"],
    danger: ["color-mix(in oklch, var(--destructive) 20%, transparent)", "#ff8a6b", "color-mix(in oklch, var(--destructive) 46%, transparent)"],
    "risk-low": ["color-mix(in oklch, var(--success) 18%, transparent)", "#67d182", "color-mix(in oklch, var(--success) 40%, transparent)"],
    "risk-medium": ["color-mix(in oklch, var(--warning) 20%, transparent)", "#ffbe63", "color-mix(in oklch, var(--warning) 44%, transparent)"],
    "risk-high": ["color-mix(in oklch, var(--destructive) 20%, transparent)", "#ff8a6b", "color-mix(in oklch, var(--destructive) 46%, transparent)"],
  };
  return map[variant] || map.default;
}

export function Badge({ variant = "default", mono = false, dot = false, children, style, className, ...props }) {
  const [bg, fg, bd] = tones(variant);
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px",
        fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: mono ? "0.04em" : "0",
        lineHeight: 1.4,
        color: fg,
        background: bg,
        border: `1px solid ${bd}`,
        borderRadius: "var(--radius-sm)",
        whiteSpace: "nowrap",
        ...style,
      }}
      {...props}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: fg }} />}
      {children}
    </span>
  );
}
