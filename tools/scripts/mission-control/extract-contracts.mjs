// Extract every registerCapability() declaration from the current contracts tree.
// The canonical tool name is a string literal, so Appendix E's `Absorbs` column
// can be joined directly against it with no name-transform guessing.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2];
const OUT = process.argv[3];

const files = readdirSync(DIR).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
);

// Pull a top-level key's raw value out of the registerCapability object literal.
// Anchored past `registerCapability(` — several contracts define an input schema
// as a separate const above it whose own fields (`name:`, `mode:`) are indented
// identically and would otherwise win the match.
function field(src, key) {
  const anchor = src.indexOf("registerCapability(");
  if (anchor === -1) return null;
  const body = src.slice(anchor);
  const re = new RegExp(`\\n\\s{2}${key}:\\s*`, "");
  const m = re.exec(body);
  if (!m) return null;
  const src2 = body;
  const start = m.index + m[0].length;
  return scan(src2, start);
}

function scan(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return src.slice(start, i).trim();
      depth--;
    } else if (c === "," && depth === 0) return src.slice(start, i).trim();
  }
  return null;
}

const unquote = (v) => (v ? v.replace(/^["']|["']$/g, "") : null);

const rows = [];
for (const f of files) {
  const src = readFileSync(join(DIR, f), "utf8");
  if (!src.includes("registerCapability(")) continue;
  const name = unquote(field(src, "name"));
  if (!name) continue;

  const agent = field(src, "agent") || "";
  const riskLevel = /riskLevel:\s*["']([^"']+)["']/.exec(agent)?.[1] ?? null;
  const category = /category:\s*["']([^"']+)["']/.exec(agent)?.[1] ?? null;
  const requiresApproval = /requiresApproval:\s*(true|false)/.exec(agent)?.[1] ?? null;

  const input = field(src, "input");
  const output = field(src, "output");

  rows.push({
    name,
    file: f,
    domain: unquote(field(src, "domain")),
    mode: unquote(field(src, "mode")),
    sensitivity: unquote(field(src, "sensitivity")),
    defaultEffect: unquote(field(src, "defaultEffect")),
    scoped: field(src, "scoped"),
    surfaces: field(src, "surfaces"),
    riskLevel,
    category,
    requiresApproval,
    hasInput: Boolean(input && input !== "z.object({})"),
    hasOutput: Boolean(output && output !== "z.object({})"),
    inputLines: input ? input.split("\n").length : 0,
    outputLines: output ? output.split("\n").length : 0,
  });
}

rows.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(OUT, JSON.stringify(rows, null, 2));

const withBoth = rows.filter((r) => r.hasInput && r.hasOutput).length;
const withRisk = rows.filter((r) => r.riskLevel).length;
const withEffect = rows.filter((r) => r.defaultEffect).length;
console.log(`contracts parsed:      ${rows.length}`);
console.log(`with input AND output: ${withBoth}`);
console.log(`with riskLevel:        ${withRisk}`);
console.log(`with defaultEffect:    ${withEffect}`);
console.log(`distinct domains:      ${new Set(rows.map((r) => r.domain)).size}`);
