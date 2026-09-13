// Emit the six-column traceability matrix as a reviewable document.
// Consumes the script-generated mechanical columns plus the audited judgment
// columns, applies the auditor's corrections, and marks what is still uncertain.
import { readFileSync, writeFileSync } from "node:fs";

const base = JSON.parse(readFileSync(process.argv[2], "utf8")); // full-matrix.json
const audited = JSON.parse(readFileSync(process.argv[3], "utf8")); // {assignments, audit}
const OUT = process.argv[4];

const { rows, TABLES, SCREENS, MILESTONES } = base;
const assign = new Map((audited.assignments || []).map((a) => [a.tool, a]));

// Apply the auditor's corrections on top of the assignments.
// A correction's `to` is free text. Split it into a list only when every part is
// a real screen name — otherwise the auditor wrote prose ("none — sign-in flow,
// not a page") and comma-splitting it invents screens that do not exist.
const SCREEN_NAMES = new Set([...SCREENS.map((s) => s.screen), "headless", "chrome"]);
const asList = (v) => {
  const parts = v.split(",").map((s) => s.trim());
  return parts.length > 1 && parts.every((p) => SCREEN_NAMES.has(p)) ? parts : null;
};

const applied = [];
for (const c of audited.audit?.corrections ?? []) {
  const a = assign.get(c.tool);
  if (!a) continue;
  const to = asList(c.to) ?? c.to;
  if (c.field === "milestone") a.milestone = String(to);
  else if (c.field === "screens") {
    // Normalise the auditor's "no page" prose to one stable label so the
    // by-screen rollup stays readable.
    const norm = Array.isArray(to)
      ? to
      : [/^\(?none\b/i.test(String(to)) ? "sign-in flow (not a page)" : String(to)];
    a.screens = norm;
  }
  else if (c.field === "tables") a.tables = Array.isArray(to) ? to : [to];
  else continue;
  a.corrected = true;
  applied.push(c);
}

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");
const code = (xs) => (xs?.length ? xs.map((x) => `\`${x}\``).join(" ") : "—");

let md = `# Mission Control — traceability matrix

Every target tool in Appendix E, traced to the code it replaces, the screen that surfaces it,
the mockup function that draws it, the tables it touches, and the milestone that ships it.

Regenerate the mechanical columns with \`tools/scripts/mission-control/build-full-matrix.mjs\`.
The three judgment columns were assigned by five agents reading §14, §17 and Appendix A, then
audited adversarially by a sixth. **The matrix is generated; do not hand-edit it.**

| Column | Source | Mechanical? |
|---|---|---|
| Tool | Appendix E | yes — literal |
| Absorbs | joined on \`registerCapability({name})\` in \`packages/oxagen/src/contracts/\` | yes — literal |
| Screen | §14's ten screens and their primary actions | assigned + audited |
| Mockup fn | \`mc.html\`'s \`render()\` dispatch | yes — literal |
| Tables | Appendix A's 37 tables | assigned + audited |
| Milestone | §17 M0–M6 | assigned + audited |

`;

// ---- summary ----
const grade = (r) => r.grade;
const counts = { INHERIT: 0, MERGE: 0, NEW: 0 };
for (const r of rows) counts[grade(r)]++;

md += `## Where the work actually is\n\n`;
md += `| Grade | Meaning | Count |\n|---|---|---|\n`;
md += `| \`INHERIT\` | every absorbed contract resolves; schema, risk grade and default effect carry forward | ${counts.INHERIT} |\n`;
md += `| \`MERGE\` | some absorbed contracts resolve, some do not | ${counts.MERGE} |\n`;
md += `| \`NEW\` | nothing resolves; genuine design work | ${counts.NEW} |\n\n`;

const byM = {};
for (const r of rows) {
  const m = assign.get(r.tool)?.milestone ?? r.milestone;
  (byM[m] ??= { total: 0, NEW: 0 }).total++;
  if (grade(r) === "NEW") byM[m].NEW++;
}
md += `### By milestone\n\n| Milestone | Delivers | Tools | of which \`NEW\` |\n|---|---|---|---|\n`;
for (const ms of MILESTONES) {
  const c = byM[ms.id] ?? { total: 0, NEW: 0 };
  md += `| **${ms.id}** ${esc(ms.name)} | ${esc(ms.delivers.slice(0, 90))}… | ${c.total} | ${c.NEW} |\n`;
}

const byS = {};
for (const r of rows) for (const s of assign.get(r.tool)?.screens ?? []) byS[s] = (byS[s] ?? 0) + 1;
md += `\n### By screen\n\n| Screen | Job (§14) | Tools |\n|---|---|---|\n`;
for (const s of SCREENS) {
  md += `| **${esc(s.screen)}** | ${esc(s.job.slice(0, 80))}… | ${byS[s.screen] ?? 0} |\n`;
}
const extraScreens = Object.keys(byS).filter((s) => !SCREENS.some((x) => x.screen === s));
for (const s of extraScreens) md += `| ${esc(s)} | *(not a §14 page)* | ${byS[s]} |\n`;

// ---- the matrix ----
const groups = [...new Set(rows.map((r) => r.group))];
for (const g of groups) {
  md += `\n\n## ${g}\n\n`;
  md += `| Tool | Grade | Absorbs | Screen | Mockup fn | Tables | M |\n|---|---|---|---|---|---|---|\n`;
  for (const r of rows.filter((x) => x.group === g)) {
    const a = assign.get(r.tool);
    const absorbs = r.absorbs.length
      ? r.absorbs.map((x) => `\`${x.file ?? x.name}\``).join("<br>")
      : "— *new*";
    const fns = r.renderFns.length
      ? r.renderFns.map((f) => `\`${f.fn}\`:${f.line}`).join("<br>")
      : "—";
    const flag = a?.corrected ? " ⚑" : a?.confidence === "low" ? " ?" : "";
    md += `| \`${r.tool}\` | ${r.grade} | ${absorbs} | ${esc((a?.screens ?? []).join(", ")) || "—"}${flag} | ${fns} | ${code(a?.tables)} | ${a?.milestone ?? "?"} |\n`;
  }
}

md += `\n\n⚑ = changed by the audit. ? = the assigning agent marked it low confidence.\n`;

// ---- audit record ----
md += `\n---\n\n## Audit\n\n> ${esc(audited.audit?.verdict ?? "(no verdict returned)")}\n\n`;
md += `**${applied.length} corrections applied.**\n\n`;
if (applied.length) {
  md += `| Tool | Field | From | To | Why |\n|---|---|---|---|---|\n`;
  for (const c of applied) {
    md += `| \`${c.tool}\` | ${esc(c.field)} | ${esc(c.from)} | ${esc(c.to)} | ${esc(c.why)} |\n`;
  }
}
const gaps = audited.audit?.gaps ?? [];
md += `\n### Structural gaps the audit found (${gaps.length})\n\n`;
md += gaps.length ? gaps.map((x) => `- ${x}`).join("\n") : "_none reported_";

// ---- table coverage ----
const touched = new Set((audited.assignments || []).flatMap((a) => a.tables || []));
const untouched = TABLES.filter((t) => !touched.has(t));
md += `\n\n### Appendix A coverage\n\n`;
md += `${touched.size} of ${TABLES.length} target tables are read or written by at least one tool.\n\n`;
if (untouched.length) {
  md += `Untouched — either a missing tool or a table that should not be in Appendix A:\n\n`;
  md += untouched.map((t) => `- \`${t}\``).join("\n");
}
md += `\n`;

writeFileSync(OUT, md);
console.log(`wrote ${OUT}`);
console.log(`  assignments: ${assign.size}/96`);
console.log(`  corrections: ${applied.length}`);
console.log(`  gaps:        ${gaps.length}`);
console.log(`  tables touched: ${touched.size}/${TABLES.length}`);
