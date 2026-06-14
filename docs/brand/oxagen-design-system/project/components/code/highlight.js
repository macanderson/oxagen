/*
 * highlight.js — tiny, dependency-free syntax tokenizer used by CodeBlock and
 * CodeTabs. Colours comments, strings, numbers and a broad keyword set in the
 * jewel palette. Not a full parser — intentionally small and language-agnostic.
 */
import * as React from "react";

const COLORS = {
  comment: "var(--muted-foreground)",
  string: "var(--cyan-300)",
  number: "#f088a6",
  keyword: "var(--ox-violet-bright, #9b7bff)",
};

// Order matters: earlier patterns win at a given position.
const SPEC = [
  ["comment", /\/\/[^\n]*|#[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\//y],
  ["string", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/y],
  ["number", /\b\d[\d_.]*(?:e[+-]?\d+)?\b/iy],
  ["keyword", /\b(?:const|let|var|function|func|fn|return|if|elif|else|for|while|do|switch|case|break|continue|import|from|export|default|class|extends|implements|interface|type|enum|new|delete|await|async|yield|try|catch|finally|throw|public|private|protected|static|readonly|def|lambda|pass|with|as|in|of|is|not|and|or|match|use|pub|impl|struct|trait|mod|where|select|insert|update|delete|create|merge|MATCH|RETURN|WHERE|CREATE|MERGE|WITH|true|false|null|nil|None|True|False|void|self|this)\b/y],
  ["ident", /[A-Za-z_$][\w$]*/y],
  ["ws", /\s+/y],
  ["any", /[\s\S]/y],
];

/** Returns an array of strings / colored <span> React nodes for `code`. */
export function highlight(code) {
  const out = [];
  let i = 0;
  let key = 0;
  while (i < code.length) {
    let matched = false;
    for (const [type, re] of SPEC) {
      re.lastIndex = i;
      const mm = re.exec(code);
      if (mm && mm.index === i && mm[0].length > 0) {
        const text = mm[0];
        const color = COLORS[type];
        if (color) out.push(React.createElement("span", { key: key++, style: { color } }, text));
        else out.push(text);
        i += text.length;
        matched = true;
        break;
      }
    }
    if (!matched) { out.push(code[i]); i++; }
  }
  return out;
}
