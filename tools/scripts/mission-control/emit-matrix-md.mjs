// Emit the traceability matrix as a reviewable markdown doc.
import { readFileSync, writeFileSync } from "node:fs";

const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
const orphans = JSON.parse(readFileSync(process.argv[3], "utf8"));
const OUT = process.argv[4];

const esc = (s) => (s || "").replace(/\|/g, "\\|");
const grade = (t) => (t.resolved.length === 0 ? "NEW" : t.unresolved.length ? "MERGE" : "INHERIT");

const groups = [...new Set(tools.map((t) => t.group))];

let md = `# Mission Control — tool traceability matrix

Generated from Appendix E of \`2026-09-11-oxagen-mission-control-spec.md\` joined against
the \`registerCapability()\` declarations in \`packages/oxagen/src/contracts/\`.
Regenerate with \`tools/scripts/mission-control/build-matrix.mjs\`.

| Grade | Meaning | Count |
|---|---|---|
| \`INHERIT\` | every absorbed contract resolves to a live file; input/output schema, risk grade and default effect are carried forward | ${tools.filter((t) => grade(t) === "INHERIT").length} |
| \`MERGE\` | some absorbed contracts resolve, some do not | ${tools.filter((t) => grade(t) === "MERGE").length} |
| \`NEW\` | nothing resolves; the schema is genuine design work | ${tools.filter((t) => grade(t) === "NEW").length} |

**${tools.length} target tools. ${orphans.length} live contracts have no absorber and are deletion candidates (see bottom).**

`;

for (const g of groups) {
  const rows = tools.filter((t) => t.group === g);
  md += `\n## ${g} (${rows.length})\n\n`;
  md += `| Tool | Grade | Inherits schema from | Risk | Effect |\n|---|---|---|---|---|\n`;
  for (const t of rows) {
    const from = t.resolved.length ? t.resolved.map((r) => `\`${r}\``).join(", ") : "—";
    md += `| \`${t.name}\` | ${grade(t)} | ${from} | ${t.inherit?.riskLevel ?? "—"} | ${t.inherit?.defaultEffect ?? "—"} |\n`;
  }
}

md += `\n---\n\n## Deletion candidates — contracts no target tool absorbs (${orphans.length})\n\n`;
md += `| Contract | File | Domain |\n|---|---|---|\n`;
for (const o of orphans.sort((a, b) => (a.domain || "").localeCompare(b.domain || ""))) {
  md += `| \`${o.name}\` | \`${o.file}\` | ${esc(o.domain)} |\n`;
}

writeFileSync(OUT, md);
console.log(`wrote ${OUT} (${md.split("\n").length} lines)`);
