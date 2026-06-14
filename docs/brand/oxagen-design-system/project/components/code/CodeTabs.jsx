import * as React from "react";
import { m, AnimatePresence } from "../lib/motion.js";
import { highlight } from "./highlight.js";
import { LangIcon } from "./LangIcon.jsx";
import { CopyButton } from "./CodeBlock.jsx";

/**
 * Oxagen CodeTabs — multi-language code sample. A tab per language (with its
 * language glyph), a copy button bound to the active tab, and a fade between
 * languages. The dev-docs pattern for "here's the same call in TS / Python / cURL".
 * `tabs: { language, label?, filename?, code }[]`.
 */
export function CodeTabs({ tabs = [], defaultIndex = 0, showLineNumbers = false, style }) {
  const [idx, setIdx] = React.useState(defaultIndex);
  const active = tabs[idx] || { code: "", language: "" };
  const Body = m("div");
  const lines = (active.code || "").replace(/\n$/, "").split("\n");

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--background-2)", overflow: "hidden", ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 2, overflowX: "auto" }}>
          {tabs.map((t, i) => {
            const on = i === idx;
            return (
              <button
                key={i}
                onClick={() => setIdx(i)}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 7,
                  padding: "5px 10px", borderRadius: "var(--radius-sm)", border: "1px solid transparent",
                  background: on ? "var(--background-2)" : "transparent",
                  boxShadow: on ? "inset 0 0 0 1px var(--border)" : "none",
                  color: on ? "var(--foreground)" : "var(--muted-foreground)",
                  fontFamily: "var(--font-sans)", fontSize: 12.5, fontWeight: on ? 600 : 500,
                  cursor: "pointer", whiteSpace: "nowrap",
                }}
              >
                <LangIcon language={t.language} size={17} />
                {t.label || t.filename || t.language}
              </button>
            );
          })}
        </div>
        <span style={{ marginLeft: "auto" }}><CopyButton getText={() => active.code} /></span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <Body
          key={idx}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <pre style={{ margin: 0, padding: "14px 16px", overflowX: "auto", fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.65 }}>
            <code style={{ fontFamily: "inherit", display: "block" }}>
              {showLineNumbers
                ? lines.map((ln, i) => (
                    <span key={i} style={{ display: "grid", gridTemplateColumns: "2ch 1fr", gap: 14 }}>
                      <span style={{ color: "var(--muted-foreground)", opacity: 0.5, userSelect: "none", textAlign: "right" }}>{i + 1}</span>
                      <span>{highlight(ln)}{"\n"}</span>
                    </span>
                  ))
                : highlight(active.code || "")}
            </code>
          </pre>
        </Body>
      </AnimatePresence>
    </div>
  );
}
