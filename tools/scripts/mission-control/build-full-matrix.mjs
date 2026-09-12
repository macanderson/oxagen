// The six-column traceability matrix:
//   tool → absorbed contract files → owning screen (§14) → mockup render fn
//        → target tables (Appendix A) → milestone (§17)
//
// Columns 1, 2 and 4 are mechanical (a literal join, and a fixed screen→function
// map read out of mc.html's render() dispatch). Columns 3, 5 and 6 are PROPOSED
// here and must be audited — the script says so in the output rather than
// pretending otherwise.
import { readFileSync, writeFileSync } from "node:fs";

const SPEC = readFileSync(process.argv[2], "utf8");
const MOCKUP = readFileSync(process.argv[3], "utf8");
const contracts = JSON.parse(readFileSync(process.argv[4], "utf8"));
const tools = JSON.parse(readFileSync(process.argv[5], "utf8"));
const OUT = process.argv[6];

const lines = SPEC.split("\n");
const fileOf = new Map(contracts.map((c) => [c.name, c.file]));

// ---------- Appendix A: the 35 target tables ----------
const aStart = lines.findIndex((l) => l.startsWith("## Appendix A."));
const aEnd = lines.findIndex((l) => l.startsWith("## Appendix B."));
const TABLES = [];
for (const l of lines.slice(aStart, aEnd)) {
  const m = /^\*\*`([a-z_]+\.[a-z_]+)`\*\*/.exec(l.trim());
  if (m) TABLES.push(m[1]);
}

// ---------- §14: the ten screens and their primary actions ----------
const s14 = lines.findIndex((l) => l.startsWith("## 14. Mission Control"));
const s15 = lines.findIndex((l) => l.startsWith("## 15."));
const SCREENS = [];
for (const l of lines.slice(s14, s15)) {
  const m = /^\|\s*(?:\*\((?:panel|org)\)\*\s*)?\*\*(.+?)\*\*\s*\|([^|]*)\|([^|]*)\|/.exec(l);
  if (!m) continue;
  const name = m[1].replace(/\*/g, "").trim();
  SCREENS.push({
    screen: name,
    job: m[2].trim(),
    actions: m[3].split(",").map((s) => s.trim().replace(/`/g, "")).filter(Boolean),
  });
}

// ---------- mc.html: screen → render function, read from render() ----------
const RENDER = {};
for (const m of MOCKUP.matchAll(/\n\s*(?:else\s+)?if\(r\.page==="([a-z]+)"\)\s*page=(p[A-Za-z]+)\(/g)) {
  RENDER[m[1]] = m[2];
}
// line number of each render function's definition
const FN_LINE = {};
MOCKUP.split("\n").forEach((l, i) => {
  const m = /^function (p[A-Z][A-Za-z]*)/.exec(l);
  if (m) FN_LINE[m[1]] = i + 1;
});

// The §14 screen names map onto mc.html's route keys. Agents/Run/etc. have
// sub-pages (agent detail, mandate, source) that belong to the same screen.
const SCREEN_TO_PAGES = {
  Fleet: ["fleet"],
  Run: ["run"],
  Approvals: ["fleet", "run"], // a panel, not a page (§14)
  Agents: ["agents", "agent", "mandate", "agentsource"],
  Tools: ["tools"],
  Ontology: ["ontology"],
  Steering: ["steering"],
  Spend: ["spend"],
  Organization: ["organization"],
  Billing: ["billing"],
  Audit: ["audit"],
};

// ---------- proposal: group → screen ----------
const GROUP_TO_SCREEN = {
  "Organization and workspace": ["Organization"],
  "Identity and access": ["Organization", "Agents"],
  "Wrapping and control": ["Fleet", "Run"],
  Toolbelt: ["Tools"],
  "Ontology and knowledge": ["Ontology"],
  "Context and steering": ["Steering"],
  "Spend and billing": ["Spend", "Billing"],
  "Audit and compliance": ["Audit"],
  "Assistant and account": ["Organization"], // assistant panel + Account dialog
};

// ---------- proposal: §17 milestone ----------
const m17 = lines.findIndex((l) => l.startsWith("## 17. Delivery plan"));
const MILESTONES = [];
for (const l of lines.slice(m17, m17 + 30)) {
  const m = /^\|\s*\*\*(M\d) (.+?)\*\*[^|]*\|([^|]*)\|/.exec(l);
  if (m) MILESTONES.push({ id: m[1], name: m[2], delivers: m[3].toLowerCase() });
}

const MILESTONE_HINT = [
  [/mandate|kill switch|policy|approval|budget|credential broker|taint|receipt/, "M2"],
  [/reconcil|statement|archive|compaction|hold|erasure|retention/, "M5"],
  [/witness|proof|proven|airlock|tamper/, "M6"],
  [/ontology|graph|connector|embedding|repo|issue|entity|source/, "M4"],
  [/record|reflector|promoter|context pr|steering/, "M3"],
  [/gateway|frame|run token|attestation|halt|replay|model route|funding/, "M1"],
  [/org|workspace|member|role|api key|tenan|iam|registry/, "M0"],
];

function proposeMilestone(t) {
  const hay = `${t.name} ${t.does} ${t.group}`.toLowerCase();
  for (const [re, id] of MILESTONE_HINT) if (re.test(hay)) return id;
  return "M0";
}

// ---------- proposal: target tables ----------
// A tool touches a table when the table's object name appears in the tool's name
// or its job description. Deliberately generous: an over-broad proposal is
// cheaper to audit down than a missing one is to notice.
function proposeTables(t) {
  const hay = `${t.name} ${t.does}`.toLowerCase();
  const hits = new Set();
  for (const tbl of TABLES) {
    const obj = tbl.split(".")[1];
    const sing = obj.replace(/ies$/, "y").replace(/ses$/, "s").replace(/s$/, "");
    const words = [obj, sing, ...sing.split("_")].filter((w) => w.length > 3);
    if (words.some((w) => hay.includes(w))) hits.add(tbl);
  }
  return [...hits];
}

// ---------- assemble ----------
const rows = tools.map((t) => {
  const screens = GROUP_TO_SCREEN[t.group] ?? [];
  const pages = screens.flatMap((s) => SCREEN_TO_PAGES[s] ?? []);
  const fns = [...new Set(pages.map((p) => RENDER[p]).filter(Boolean))];
  return {
    tool: t.name,
    grade: t.resolved.length === 0 ? "NEW" : t.unresolved.length ? "MERGE" : "INHERIT",
    group: t.group,
    does: t.does,
    absorbs: t.resolved.map((r) => ({ name: r, file: fileOf.get(r) ?? null })),
    unresolved: t.unresolved,
    // proposed, needs audit
    screens,
    renderFns: fns.map((f) => ({ fn: f, line: FN_LINE[f] ?? null })),
    tables: proposeTables(t),
    milestone: proposeMilestone(t),
  };
});

writeFileSync(OUT, JSON.stringify({ rows, TABLES, SCREENS, MILESTONES }, null, 2));

console.log(`tools:                 ${rows.length}`);
console.log(`Appendix A tables:     ${TABLES.length}`);
console.log(`§14 screens parsed:    ${SCREENS.length}  (${SCREENS.map((s) => s.screen).join(", ")})`);
console.log(`§17 milestones parsed: ${MILESTONES.length}`);
console.log(`mc.html render map:    ${Object.keys(RENDER).length} pages`);
console.log(``);
console.log(`rows with no table proposed: ${rows.filter((r) => !r.tables.length).length}`);
console.log(`rows with no render fn:      ${rows.filter((r) => !r.renderFns.length).length}`);
const byM = {};
for (const r of rows) byM[r.milestone] = (byM[r.milestone] ?? 0) + 1;
console.log(`milestone spread:            ${JSON.stringify(byM)}`);
