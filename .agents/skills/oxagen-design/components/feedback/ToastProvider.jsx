import * as React from "react";
import { m, AnimatePresence, SPRING } from "../lib/motion.js";

/**
 * Oxagen Toast system. Wrap your app in <ToastProvider>, then call
 * useToast().push({ title, description, tone, icon }). Toasts stack bottom-right
 * and animate in with a spring + auto-dismiss.
 */
const ToastCtx = React.createContext(null);

const TONES = {
  default: ["var(--border)", "var(--ox-violet-bright, #9b7bff)"],
  success: ["color-mix(in oklch, var(--success) 50%, var(--border))", "#67d182"],
  warning: ["color-mix(in oklch, var(--warning) 50%, var(--border))", "#ffbe63"],
  danger: ["color-mix(in oklch, var(--destructive) 50%, var(--border))", "#ff8a6b"],
  cyan: ["color-mix(in oklch, var(--cyan-400) 50%, var(--border))", "var(--cyan-300)"],
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = React.useState([]);
  const push = React.useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((cur) => [...cur, { id, tone: "default", duration: 4000, ...t }]);
    return id;
  }, []);
  const dismiss = React.useCallback((id) => setToasts((cur) => cur.filter((t) => t.id !== id)), []);

  React.useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => dismiss(t.id), t.duration));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);

  const Item = m("div");
  return (
    <ToastCtx.Provider value={{ push, dismiss }}>
      {children}
      <div style={{ position: "fixed", right: 16, bottom: 16, zIndex: 80, display: "flex", flexDirection: "column", gap: 10, width: 320, maxWidth: "calc(100vw - 32px)" }}>
        <AnimatePresence>
          {toasts.map((t) => {
            const [bd, accent] = TONES[t.tone] || TONES.default;
            return (
              <Item
                key={t.id}
                layout
                initial={{ opacity: 0, x: 24, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, scale: 0.96 }}
                transition={SPRING}
                style={{
                  display: "flex", gap: 11, padding: "12px 13px",
                  background: "var(--popover)", color: "var(--popover-foreground)",
                  border: `1px solid ${bd}`, borderRadius: "var(--radius-lg)",
                  boxShadow: "var(--shadow-lg)",
                }}
              >
                {t.icon && <span style={{ color: accent, marginTop: 1, flexShrink: 0 }}>{t.icon}</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {t.title && <div style={{ fontSize: 13, fontWeight: 600 }}>{t.title}</div>}
                  {t.description && <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", marginTop: 1, lineHeight: 1.45 }}>{t.description}</div>}
                </div>
                <button onClick={() => dismiss(t.id)} aria-label="Dismiss" style={{ background: "transparent", border: "none", color: "var(--muted-foreground)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: 2, alignSelf: "flex-start" }}>×</button>
              </Item>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastCtx);
  if (!ctx) return { push: () => {}, dismiss: () => {} };
  return ctx;
}
