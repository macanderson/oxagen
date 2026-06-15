import * as React from "react";
import { m } from "../lib/motion.js";

/**
 * Oxagen Sidebar — the vertical product nav. Renders grouped items with a
 * gradient active-accent bar that slides between items (framer-motion shared
 * layout). `groups: { label?, items: { id, label, icon?, badge? }[] }[]`.
 * `header` / `footer` slot the brand lockup and account row.
 */
function Item({ item, active, onSelect }) {
  const [hover, setHover] = React.useState(false);
  const Bar = m("span");
  return (
    <button
      onClick={() => onSelect(item.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative", display: "flex", alignItems: "center", gap: 10, width: "100%",
        padding: "8px 10px", borderRadius: "var(--radius-md)", border: "none", cursor: "pointer", textAlign: "left",
        fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: active ? 600 : 500,
        color: active ? "var(--foreground)" : "var(--muted-foreground)",
        background: active ? "var(--sidebar-accent)" : hover ? "color-mix(in oklch, var(--sidebar-accent) 55%, transparent)" : "transparent",
        transition: "background var(--motion-micro), color var(--motion-micro)",
      }}
    >
      {active && (
        <Bar layoutId="ox-sidebar-active" style={{ position: "absolute", left: 0, top: 7, bottom: 7, width: 3, borderRadius: 3, background: "var(--grad-sunset)" }} />
      )}
      {item.icon && <span style={{ color: active ? "var(--ox-violet-bright, #9b7bff)" : "inherit", display: "inline-flex" }}>{item.icon}</span>}
      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
      {item.badge != null && (
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted-foreground)", background: "var(--muted)", borderRadius: 999, padding: "1px 7px" }}>{item.badge}</span>
      )}
    </button>
  );
}

export function Sidebar({ groups = [], active, onSelect = () => {}, header, footer, width = 232, style, ...props }) {
  return (
    <aside
      style={{ width, flexShrink: 0, display: "flex", flexDirection: "column", background: "var(--sidebar)", border: "1px solid var(--sidebar-border)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-md)", overflow: "hidden", ...style }}
      {...props}
    >
      {header && <div style={{ flexShrink: 0 }}>{header}</div>}
      <nav style={{ flex: 1, padding: 8, display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
        {groups.map((g, gi) => (
          <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {gi > 0 && <div style={{ height: 1, background: "var(--sidebar-border)", margin: "8px 10px" }} />}
            {g.label && <div className="ox-eyebrow" style={{ padding: "2px 12px 6px", fontSize: 10 }}>{g.label}</div>}
            {g.items.map((it) => <Item key={it.id} item={it} active={active === it.id} onSelect={onSelect} />)}
          </div>
        ))}
      </nav>
      {footer && <div style={{ flexShrink: 0, padding: 8, borderTop: "1px solid var(--sidebar-border)" }}>{footer}</div>}
    </aside>
  );
}
