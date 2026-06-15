import * as React from "react";
import { m } from "../lib/motion.js";

/**
 * Oxagen Stepper — horizontal step progresser. Completed steps fill with a
 * gradient + check; the active step pulses a glow; the connector line fills as
 * you advance. `steps: { label, description? }[]`, `current` is the 0-based index.
 */
export function Stepper({ steps = [], current = 0, style }) {
  const Fill = m("span");
  return (
    <div style={{ display: "flex", alignItems: "flex-start", ...style }}>
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const last = i === steps.length - 1;
        return (
          <React.Fragment key={i}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, flexShrink: 0, width: 132 }}>
              <div
                style={{
                  width: 30, height: 30, borderRadius: "50%",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 600,
                  background: done || active ? "var(--grad-sunset)" : "var(--muted)",
                  color: done || active ? "#fff" : "var(--muted-foreground)",
                  border: active ? "1px solid transparent" : done ? "1px solid transparent" : "1px solid var(--border)",
                  boxShadow: active ? "var(--glow-violet)" : "none",
                }}
              >
                {done ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                ) : (i + 1)}
              </div>
              <div style={{ textAlign: "center", padding: "0 4px" }}>
                <div style={{ fontSize: 12.5, fontWeight: active ? 600 : 500, color: active || done ? "var(--foreground)" : "var(--muted-foreground)" }}>{s.label}</div>
                {s.description && <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginTop: 1, lineHeight: 1.35 }}>{s.description}</div>}
              </div>
            </div>
            {!last && (
              <div style={{ flex: 1, height: 2, background: "var(--border)", borderRadius: 2, marginTop: 14, position: "relative", overflow: "hidden" }}>
                <Fill
                  initial={false}
                  animate={{ scaleX: done ? 1 : 0 }}
                  transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                  style={{ position: "absolute", inset: 0, transformOrigin: "left", background: "var(--grad-sunset)" }}
                />
              </div>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
