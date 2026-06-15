import * as React from "react";

/**
 * LangIcon — a small, dependency-free language glyph badge (e.g. TS, PY, GO).
 * Used by CodeTabs to label tabs with language-specific marks. Pass `language`
 * (a key below) or a custom `node`.
 */
const LANGS = {
  ts: { label: "TS", bg: "#3178c6", fg: "#fff" },
  tsx: { label: "TSX", bg: "#3178c6", fg: "#fff" },
  js: { label: "JS", bg: "#f7df1e", fg: "#1b1924" },
  jsx: { label: "JSX", bg: "#f7df1e", fg: "#1b1924" },
  py: { label: "PY", bg: "#3776ab", fg: "#fff" },
  python: { label: "PY", bg: "#3776ab", fg: "#fff" },
  go: { label: "GO", bg: "#00add8", fg: "#03242b" },
  rust: { label: "RS", bg: "#dea584", fg: "#2b1a10" },
  rs: { label: "RS", bg: "#dea584", fg: "#2b1a10" },
  bash: { label: "SH", bg: "#4eaa25", fg: "#04200a" },
  sh: { label: "SH", bg: "#4eaa25", fg: "#04200a" },
  shell: { label: "SH", bg: "#4eaa25", fg: "#04200a" },
  json: { label: "{ }", bg: "#5b5766", fg: "#fff" },
  sql: { label: "SQL", bg: "#e38c00", fg: "#231300" },
  cypher: { label: "CY", bg: "#7c5aed", fg: "#fff" },
  graphql: { label: "GQL", bg: "#e10098", fg: "#fff" },
  curl: { label: "cURL", bg: "#073551", fg: "#fff" },
  http: { label: "HTTP", bg: "#5b5766", fg: "#fff" },
};

export function LangIcon({ language, node, size = 18 }) {
  if (node) return <span style={{ display: "inline-flex", width: size, height: size }}>{node}</span>;
  const l = LANGS[(language || "").toLowerCase()] || { label: (language || "·").slice(0, 3).toUpperCase(), bg: "var(--muted)", fg: "var(--muted-foreground)" };
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        minWidth: size, height: size, padding: "0 4px",
        borderRadius: 4, background: l.bg, color: l.fg,
        fontFamily: "var(--font-mono)", fontSize: size * 0.46, fontWeight: 700, letterSpacing: "0.02em",
      }}
    >
      {l.label}
    </span>
  );
}
