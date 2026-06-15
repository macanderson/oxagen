import * as React from "react";
import { m, AnimatePresence, SPRING, EASE_EXIT } from "../lib/motion.js";

/**
 * Oxagen Dialog — centered modal with a blurred scrim. Animates in/out with
 * framer-motion (scrim fade + content spring-up). Controlled via `open`.
 */
export function Dialog({ open, onClose, title, description, children, footer, width = 460 }) {
  React.useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose?.(); }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const Scrim = m("div");
  const Panel = m("div");

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
          style={{
            position: "fixed", inset: 0, zIndex: 60,
            display: "grid", placeItems: "center", padding: 20,
            background: "color-mix(in oklch, var(--ink-950) 60%, transparent)",
            backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
          }}
        >
          <Panel
            key="panel"
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.14, ease: EASE_EXIT } }}
            transition={SPRING}
            role="dialog"
            aria-modal="true"
            style={{
              width: "100%", maxWidth: width,
              background: "var(--popover)", color: "var(--popover-foreground)",
              border: "1px solid var(--border)", borderRadius: "var(--radius-xl)",
              boxShadow: "var(--shadow-xl)", overflow: "hidden",
            }}
          >
            {(title || description) && (
              <div style={{ padding: "20px 22px 0" }}>
                {title && <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>{title}</h2>}
                {description && <p style={{ margin: "6px 0 0", fontSize: 13.5, lineHeight: 1.55, color: "var(--muted-foreground)" }}>{description}</p>}
              </div>
            )}
            <div style={{ padding: "16px 22px", fontSize: 13.5, lineHeight: 1.6 }}>{children}</div>
            {footer && (
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "0 22px 20px" }}>{footer}</div>
            )}
          </Panel>
        </Scrim>
      )}
    </AnimatePresence>
  );
}
