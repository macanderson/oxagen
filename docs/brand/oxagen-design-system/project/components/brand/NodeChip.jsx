import * as React from "react";

/**
 * NodeChip — a knowledge-graph node reference. A typed dot + mono node id,
 * the way the product renders entities in edge diagrams and tool output.
 * `kind` colours the dot by entity class.
 */
const KIND_COLOR = {
  user: "var(--cyan-400)",
  document: "var(--violet-400)",
  service: "#67d182",
  policy: "var(--cosmos-400)",
  resource: "var(--warning)",
  default: "var(--muted-foreground)",
};

export function NodeChip({ kind = "default", id, label, style, ...props }) {
  const color = KIND_COLOR[kind] || KIND_COLOR.default;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 9px 3px 8px",
        background: "var(--background-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-full)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--foreground)",
        whiteSpace: "nowrap",
        ...style,
      }}
      {...props}
    >
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0, boxShadow: `0 0 6px ${color}` }} />
      {label && <span style={{ fontFamily: "var(--font-sans)", fontWeight: 500 }}>{label}</span>}
      {id && <span style={{ color: "var(--muted-foreground)", letterSpacing: "0.02em" }}>{id}</span>}
    </span>
  );
}
