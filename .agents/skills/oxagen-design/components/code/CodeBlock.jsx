import * as React from "react";
import { highlight } from "./highlight.js";
import { LangIcon } from "./LangIcon.jsx";

/** Shared copy-to-clipboard button with a "Copied" confirmation. */
export function CopyButton({ getText }) {
  const [copied, setCopied] = React.useState(false);
  function copy() {
    const text = getText();
    try {
      navigator.clipboard?.writeText(text);
    } catch (e) { /* clipboard unavailable */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }
  return (
    <button
      onClick={copy}
      aria-label="Copy code"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        height: 26, padding: "0 9px", borderRadius: "var(--radius-sm)",
        border: "1px solid var(--border)", background: "var(--background-2)",
        color: copied ? "#67d182" : "var(--muted-foreground)",
        fontFamily: "var(--font-sans)", fontSize: 11.5, fontWeight: 600, cursor: "pointer",
        transition: "color var(--motion-micro)",
      }}
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeBody({ code, showLineNumbers }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <pre style={{ margin: 0, padding: "14px 16px", overflowX: "auto", fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.65 }}>
      <code style={{ fontFamily: "inherit", display: "block" }}>
        {showLineNumbers
          ? lines.map((ln, i) => (
              <span key={i} style={{ display: "grid", gridTemplateColumns: "2ch 1fr", gap: 14 }}>
                <span style={{ color: "var(--muted-foreground)", opacity: 0.5, userSelect: "none", textAlign: "right" }}>{i + 1}</span>
                <span>{highlight(ln)}{"\n"}</span>
              </span>
            ))
          : highlight(code)}
      </code>
    </pre>
  );
}

/**
 * Oxagen CodeBlock — a single source listing with a header (language glyph +
 * filename) and a copy button. Mono is used here because this IS source code.
 */
export function CodeBlock({ code = "", language = "ts", filename, showLineNumbers = false, copy = true, style }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--background-2)", overflow: "hidden", ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 10px 8px 12px", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
        <LangIcon language={language} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--muted-foreground)" }}>{filename || language}</span>
        {copy && <span style={{ marginLeft: "auto" }}><CopyButton getText={() => code} /></span>}
      </div>
      <CodeBody code={code} showLineNumbers={showLineNumbers} />
    </div>
  );
}
