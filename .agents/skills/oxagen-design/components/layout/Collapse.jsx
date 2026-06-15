import * as React from "react";
import { m, AnimatePresence } from "../lib/motion.js";

/**
 * Oxagen Collapse — a single expandable disclosure row. Chevron rotates and the
 * body height-animates open/closed. Controlled (`open`) or uncontrolled
 * (`defaultOpen`).
 */
export function Collapse({ title, subtitle, icon, defaultOpen = false, open, onToggle, children, style }) {
  const [internal, setInternal] = React.useState(defaultOpen);
  const isOpen = open ?? internal;
  function toggle() {
    if (open === undefined) setInternal((v) => !v);
    onToggle?.(!isOpen);
  }
  const Body = m("div");
  const Chev = m("span");
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--card)", overflow: "hidden", ...style }}>
      <button
        onClick={toggle}
        aria-expanded={isOpen}
        style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: "13px 15px", background: "transparent", border: "none", cursor: "pointer", textAlign: "left", color: "var(--foreground)" }}
      >
        {icon && <span style={{ color: "var(--ox-violet-bright, #9b7bff)", display: "inline-flex" }}>{icon}</span>}
        <span style={{ flex: 1 }}>
          <span style={{ display: "block", fontSize: 13.5, fontWeight: 600 }}>{title}</span>
          {subtitle && <span style={{ display: "block", fontSize: 12, color: "var(--muted-foreground)", marginTop: 1 }}>{subtitle}</span>}
        </span>
        <Chev animate={{ rotate: isOpen ? 90 : 0 }} transition={{ duration: 0.2 }} style={{ color: "var(--muted-foreground)", display: "inline-flex", flexShrink: 0 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
        </Chev>
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <Body
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "0 15px 15px", fontSize: 13, lineHeight: 1.6, color: "var(--muted-foreground)" }}>{children}</div>
          </Body>
        )}
      </AnimatePresence>
    </div>
  );
}
