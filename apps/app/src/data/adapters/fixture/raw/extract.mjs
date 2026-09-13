// Re-extracts the mockup's demo data from the design baseline into
// mc-baseline-w1.json, verbatim and in the mockup's own vocabulary.
//
//   git -C ~/Documents/Oxagen/Mockups show mc-baseline-w1:mc.html > /tmp/mc.html
//   node apps/app/src/data/adapters/fixture/raw/extract.mjs /tmp/mc.html \
//     apps/app/src/data/adapters/fixture/raw/mc-baseline-w1.json
//
// Each collection is one top-level `var NAME = …;` statement in mc.html. The
// script cuts each statement out with a bracket scanner (strings and comments
// honoured) and evaluates only those statements in an empty VM context, so no
// mockup rendering code runs. Nothing is edited here: vocabulary mapping and
// the W4 integrity repairs live in ../mapping.ts, and only there.
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const [, , source, target] = process.argv;
if (!source || !target) {
  throw new Error("usage: extract.mjs <mc.html> <out.json>");
}
const html = readFileSync(source, "utf8");

const COLLECTIONS = [
  "ORG",
  "WS",
  "BRANCHES",
  "AV_SAMPLE_PHOTO",
  "PEOPLE",
  "AGENTS",
  "RUNS",
  "APPROVALS",
  "FRAMES",
  "NOTES_V1",
  "NOTES_V2",
  "TRANSCRIPTS",
  "RUNGRAPH",
  "FINDINGS",
  "EVIDENCE",
  "FIX",
  "SERVERS",
  "TOOLS",
  "CONNECTIONS",
  "MANDATES",
  "POLICIES",
  "SIM",
  "SWITCHES",
  "ASSURANCE",
  "CLASSES",
  "SOURCES",
  "REPOS",
  "ONTVERSIONS",
  "INDEXES",
  "RECORDS",
  "PROPOSALS",
  "MEMBERS",
  "INVITES",
  "AUDIT",
  "NOTIFS",
  "SPEND",
  "SPEND_DETAIL",
  "BILLING",
  "CTXW",
  "CTXB",
  "CTXF",
  "CTXX",
  "BELT",
  "AGENT_BELTS",
  "BELT_OUTSIDE",
  "APIKEYS",
  "INCIDENTS",
  "RECEIPTS",
  "HOLDS",
  "EXPORTS",
  "KEYS",
  "ASSURANCE_HISTORY",
  "ERASURE",
  "RETENTION_TIERS",
  "OBSERVED_SCHEMAS",
  "OBSERVED_SAMPLES",
  "SCORES",
  "ROLES",
  "PERMS",
  "AUTORULES",
];

/** The statement starting at `start`, up to its `;` at bracket depth 0. */
function statementAt(start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    const next = html[i + 1];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && next === "*") i = html.indexOf("*/", i + 2) + 1;
    else if (c === "/" && next === "/") i = html.indexOf("\n", i);
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unterminated statement at offset ${String(start)}`);
}

function declaration(name) {
  const match = new RegExp(`(^|\\n)\\s*var ${name}\\s*=`).exec(html);
  if (!match) throw new Error(`mc.html declares no var ${name}`);
  return statementAt(match.index + match[1].length);
}

const chunks = COLLECTIONS.map(declaration);
// The IAM half of each agent is merged onto AGENTS by an IIFE right after it.
const iam = html.indexOf("(function(){\n var IAM=");
if (iam < 0) throw new Error("mc.html has no IAM merge block");
chunks.splice(COLLECTIONS.indexOf("AGENTS") + 1, 0, statementAt(iam));
// Agent role assignments live on the mockup's state object.
const roles = html.indexOf("S.agentRoles={");
if (roles < 0) throw new Error("mc.html has no S.agentRoles");
chunks.push(
  `var AGENT_ROLES=${statementAt(roles).slice("S.agentRoles=".length)}`,
);

// OBSERVED_SCHEMAS builds syntax-highlighted HTML through pj()/ps(); these
// stand-ins emit the same JSON text without the markup.
const prelude =
  'function pj(k,v){return JSON.stringify(k)+": "+v;}function ps(s){return JSON.stringify(s);}';
const names = [...COLLECTIONS, "AGENT_ROLES"];
const program = `${prelude}\n${chunks.join("\n")}\n__out={${names.map((n) => `${n}:${n}`).join(",")}};`;
const context = { __out: null, encodeURIComponent };
vm.createContext(context);
vm.runInContext(program, context);
writeFileSync(target, `${JSON.stringify(context.__out, null, 1)}\n`);
console.log(`wrote ${target}: ${String(names.length)} collections`);
