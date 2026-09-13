// Join Appendix E (96 target tools + what each absorbs) against the 228 live
// contracts, and Appendix F (10 surviving pages + absorbed routes) against the
// 70 route files. Output: the traceability matrix + a candid gap report.
import { readFileSync, writeFileSync } from "node:fs";

const SPEC = readFileSync(process.argv[2], "utf8");
const contracts = JSON.parse(readFileSync(process.argv[3], "utf8"));
const OUT = process.argv[4];

const byName = new Map(contracts.map((c) => [c.name, c]));

// ---------- Appendix E ----------
const lines = SPEC.split("\n");
const eStart = lines.findIndex((l) => l.startsWith("## Appendix E."));
const eEnd = lines.findIndex((l) => l.startsWith("## Appendix F."));
const eLines = lines.slice(eStart, eEnd);

const tools = [];
let group = null;
for (const line of eLines) {
  const g = /^\*\*(.+?)\s*\((\d+)\)\*\*/.exec(line);
  if (g) {
    group = g[1];
    continue;
  }
  // table row: | `tool_name` | absorbs | does |
  const m = /^\|\s*`([a-z0-9_]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
  if (!m) continue;
  const name = m[1];
  const absorbsRaw = m[2].trim();
  const does = m[3].trim();

  const isNew = /^\(new/i.test(absorbsRaw) || absorbsRaw === "";
  const absorbs = isNew
    ? []
    : absorbsRaw
        .replace(/`/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && /^[a-z0-9_]+$/.test(s));

  const resolved = absorbs.filter((a) => byName.has(a));
  const unresolved = absorbs.filter((a) => !byName.has(a));

  tools.push({
    name,
    group,
    does,
    absorbs,
    resolved,
    unresolved,
    isNew,
    // inherited metadata from the richest absorbed contract
    inherit: resolved
      .map((r) => byName.get(r))
      .sort((a, b) => b.inputLines + b.outputLines - (a.inputLines + a.outputLines))[0] ?? null,
  });
}

// ---------- classification ----------
const GREEN = tools.filter((t) => t.resolved.length && !t.unresolved.length);
const AMBER = tools.filter((t) => t.resolved.length && t.unresolved.length);
const RED = tools.filter((t) => !t.resolved.length);

writeFileSync(OUT, JSON.stringify(tools, null, 2));

console.log(`=== Appendix E parsed ===`);
console.log(`target tools:                 ${tools.length}`);
console.log(``);
console.log(`GREEN (all absorbed resolve): ${GREEN.length}  -> schema inherited, mechanical`);
console.log(`AMBER (partial resolve):      ${AMBER.length}  -> merge + fill gaps`);
console.log(`RED   (nothing resolves):     ${RED.length}  -> genuine new design work`);
console.log(``);
console.log(`--- RED: the real work ---`);
for (const t of RED) console.log(`  ${t.name.padEnd(26)} [${t.group}] ${t.does.slice(0, 54)}`);
console.log(``);
console.log(`--- AMBER: unresolved absorb targets ---`);
for (const t of AMBER) console.log(`  ${t.name.padEnd(26)} missing: ${t.unresolved.join(", ")}`);

// contracts that no target tool absorbs = the deletion manifest
const absorbedAll = new Set(tools.flatMap((t) => t.resolved));
const orphans = contracts.filter((c) => !absorbedAll.has(c.name));
console.log(``);
console.log(`=== deletion manifest ===`);
console.log(`contracts carried forward:    ${absorbedAll.size}`);
console.log(`contracts with no absorber:   ${orphans.length}  -> delete candidates`);
writeFileSync(OUT.replace(".json", "-orphans.json"), JSON.stringify(orphans, null, 2));
