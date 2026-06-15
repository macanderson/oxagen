import * as React from "react";
import { m } from "../lib/motion.js";

/**
 * Oxagen MainNav — a horizontal top navigation bar (marketing / docs use).
 * Brand on the left, center links with a sliding gradient underline indicator,
 * actions on the right. `items: { id, label, href? }[]`.
 */
export function MainNav({ brand, items = [], active, onSelect = () => {}, actions, sticky = false, style, ...props }) {
  const [hovered, setHovered] = React.useState(null);
  const Underline = m("span");
  return (
    <header
      style={{
        position: sticky ? "sticky" : "relative", top: 0, zIndex: 40,
        display: "flex", alignItems: "center", gap: 20,
        height: 60, padding: "0 22px",
        background: "color-mix(in oklch, var(--background) 78%, transparent)",
        backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border)",
        ...style,
      }}
      {...props}
    >
      <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>{brand}</div>
      <nav
        onMouseLeave={() => setHovered(null)}
        style={{ display: "flex", alignItems: "center", gap: 4, margin: "0 auto" }}
      >
        {items.map((it) => {
          const on = active === it.id;
          const showInd = (hovered ?? active) === it.id;
          return (
            <a
              key={it.id}
              href={it.href || "#"}
              onClick={(e) => { if (!it.href) e.preventDefault(); onSelect(it.id); }}
              onMouseEnter={() => setHovered(it.id)}
              style={{
                position: "relative", padding: "8px 14px", borderRadius: "var(--radius-md)",
                textDecoration: "none", fontSize: 13.5, fontWeight: on ? 600 : 500,
                color: on ? "var(--foreground)" : "var(--muted-foreground)",
                transition: "color var(--motion-micro)",
              }}
            >
              {it.label}
              {showInd && (
                <Underline
                  layoutId="ox-mainnav-underline"
                  style={{ position: "absolute", left: 12, right: 12, bottom: 2, height: 2, borderRadius: 2, background: "var(--grad-sunset)" }}
                />
              )}
            </a>
          );
        })}
      </nav>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>{actions}</div>
    </header>
  );
}
