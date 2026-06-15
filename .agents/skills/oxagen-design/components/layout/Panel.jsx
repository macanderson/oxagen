import * as React from "react";

/**
 * Oxagen Panel — a titled surface container with an optional header eyebrow,
 * actions slot, and footer. The workhorse layout block for settings, detail
 * views and dashboards. `inset` removes body padding for flush content (tables).
 */
export function Panel({ title, eyebrow, actions, footer, inset = false, children, style, className, ...props }) {
  return (
    <section
      className={className}
      style={{ display: "flex", flexDirection: "column", background: "var(--card)", color: "var(--card-foreground)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", boxShadow: "var(--shadow-sm)", overflow: "hidden", ...style }}
      {...props}
    >
      {(title || actions || eyebrow) && (
        <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "15px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {eyebrow && <div className="ox-eyebrow" style={{ marginBottom: 3 }}>{eyebrow}</div>}
            {title && <h3 style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>{title}</h3>}
          </div>
          {actions && <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>{actions}</div>}
        </header>
      )}
      <div style={{ padding: inset ? 0 : 18, flex: 1, minHeight: 0 }}>{children}</div>
      {footer && <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 18px", borderTop: "1px solid var(--border)", background: "var(--background-2)" }}>{footer}</footer>}
    </section>
  );
}
