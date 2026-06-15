import * as React from "react";

/**
 * ConfidenceBar — inference confidence meter for semantic edges. Colour follows
 * the product thresholds: ≥0.8 success, ≥0.6 warning, else danger.
 */
function band(score) {
  if (score >= 0.8) return ["#37a04d", "#67d182"];
  if (score >= 0.6) return ["var(--warning)", "#ffbe63"];
  return ["var(--destructive)", "#ff8a6b"];
}

export function ConfidenceBar({ score = 0, showValue = true, width = 120, style, ...props }) {
  const s = Math.max(0, Math.min(1, score));
  const [track, text] = band(s);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, ...style }} {...props}>
      <span style={{ position: "relative", width, height: 6, borderRadius: 999, background: "var(--muted)", overflow: "hidden", flexShrink: 0 }}>
        <span style={{ position: "absolute", inset: 0, width: `${s * 100}%`, background: track, borderRadius: 999, boxShadow: `0 0 8px ${track}` }} />
      </span>
      {showValue && (
        <span style={{ fontFamily: "var(--font-sans)", fontSize: 11, fontWeight: 600, color: text, fontVariantNumeric: "tabular-nums" }}>
          {Math.round(s * 100)}%
        </span>
      )}
    </span>
  );
}
