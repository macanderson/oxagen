import * as React from "react";
import { m, AnimatePresence, SPRING } from "../lib/motion.js";

/**
 * Oxagen Drawer — edge-anchored sliding panel with a scrim. `side` controls the
 * edge (right/left/bottom). Animates with a spring slide. Controlled via `open`.
 */
export function Drawer({ open, onClose, side = "right", title, description, children, footer, size = 380 }) {
  React.useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose?.(); }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const vertical = side === "bottom";
  const off = side === "left" ? { x: "-100%" } : side === "bottom" ? { y: "100%" } : { x: "100%" };
  const anchor = side === "left"
    ? { top: 0, left: 0, bottom: 0 }
    : side === "bottom"
    ? { left: 0, right: 0, bottom: 0 }
    : { top: 0, right: 0, bottom: 0 };

  const Scrim = m("div");
  const Panel = m("aside");

  return (
    <AnimatePresence>
      {open && (
        <Scrim
          key="scrim"
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{ position: "fixed", inset: 0, zIndex: 70, background: "color-mix(in oklch, var(--ink-950) 58%, transparent)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)" }}
        >
          <Panel
            key="panel"
            onClick={(e) => e.stopPropagation()}
            initial={off}
            animate={{ x: 0, y: 0 }}
            exit={off}
            transition={SPRING}
            style={{
              position: "fixed", ...anchor,
              width: vertical ? "auto" : size,
              height: vertical ? size : "auto",
              maxWidth: "100vw",
              display: "flex", flexDirection: "column",
              background: "var(--card)", color: "var(--card-foreground)",
              borderLeft: side === "right" ? "1px solid var(--border)" : "none",
              borderRight: side === "left" ? "1px solid var(--border)" : "none",
              borderTop: side === "bottom" ? "1px solid var(--border)" : "none",
              borderTopLeftRadius: side === "bottom" ? "var(--radius-xl)" : 0,
              borderTopRightRadius: side === "bottom" ? "var(--radius-xl)" : 0,
              boxShadow: "var(--shadow-xl)",
            }}
          >
            <header style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "18px 20px 0" }}>
              <div style={{ flex: 1 }}>
                {title && <h2 style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>{title}</h2>}
                {description && <p style={{ margin: "5px 0 0", fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.5 }}>{description}</p>}
              </div>
              <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: "var(--muted-foreground)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 2 }}>×</button>
            </header>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 20 }}>{children}</div>
            {footer && <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "0 20px 18px" }}>{footer}</div>}
          </Panel>
        </Scrim>
      )}
    </AnimatePresence>
  );
}
