import * as React from "react";
import { m, SPRING } from "../lib/motion.js";

/**
 * Oxagen Tabs — underline style with a gradient indicator that SLIDES between
 * tabs (framer-motion shared layout). Controlled or uncontrolled.
 * `items: { value, label, icon?, badge? }[]`.
 */
export function Tabs({ items = [], value, defaultValue, onChange, style, ...props }) {
  const [val, setVal] = React.useState(defaultValue ?? items[0]?.value);
  const active = value ?? val;
  const groupId = React.useId();
  const Indicator = m("span");

  function select(v) {
    if (value === undefined) setVal(v);
    onChange?.(v);
  }

  return (
    <div role="tablist" style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border)", ...style }} {...props}>
      {items.map((it) => {
        const on = it.value === active;
        return (
          <button
            key={it.value}
            role="tab"
            aria-selected={on}
            onClick={() => select(it.value)}
            style={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "10px 14px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
              fontSize: 13,
              fontWeight: on ? 600 : 500,
              color: on ? "var(--foreground)" : "var(--muted-foreground)",
              transition: "color var(--motion-micro)",
            }}
          >
            {it.icon}
            {it.label}
            {it.badge != null && (
              <span style={{ fontSize: 10, fontWeight: 600, color: "var(--muted-foreground)", background: "var(--muted)", borderRadius: 999, padding: "1px 6px" }}>
                {it.badge}
              </span>
            )}
            {on && (
              <Indicator
                layoutId={`ox-tabs-ind-${groupId}`}
                transition={SPRING}
                style={{ position: "absolute", left: 8, right: 8, bottom: -1, height: 2, borderRadius: 2, background: "var(--grad-sunset)" }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
