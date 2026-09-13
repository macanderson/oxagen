// Emit the P1 carry batches: each INHERIT tool with the file path of every
// contract it absorbs, so an agent can open its sources directly.
import { readFileSync, writeFileSync } from "node:fs";

const tools = JSON.parse(readFileSync(process.argv[2], "utf8"));
const contracts = JSON.parse(readFileSync(process.argv[3], "utf8"));
const fileOf = new Map(contracts.map((c) => [c.name, c.file]));

const DONE = new Set(["create_workspace"]); // the exemplar

const BATCHES = [
  { batch: "org-identity", groups: ["Organization and workspace", "Identity and access"] },
  { batch: "control-assistant", groups: ["Wrapping and control", "Assistant and account"] },
  { batch: "ontology", groups: ["Ontology and knowledge"] },
  { batch: "toolbelt-steering", groups: ["Toolbelt", "Context and steering"] },
  { batch: "spend-audit", groups: ["Spend and billing", "Audit and compliance"] },
];

const out = BATCHES.map((b) => ({
  batch: b.batch,
  tools: tools
    .filter(
      (t) =>
        b.groups.includes(t.group) &&
        t.resolved.length > 0 &&
        t.unresolved.length === 0 &&
        !DONE.has(t.name),
    )
    .map((t) => ({
      name: t.name,
      file: `${t.name.replace(/_/g, "-")}.ts`,
      group: t.group,
      does: t.does,
      absorbs: t.resolved.map((r) => ({ name: r, path: `packages/oxagen/src/contracts/${fileOf.get(r)}` })),
    })),
}));

writeFileSync(process.argv[4], JSON.stringify(out, null, 2));
let n = 0;
for (const b of out) {
  console.log(`${b.batch.padEnd(20)} ${String(b.tools.length).padStart(2)} tools`);
  n += b.tools.length;
}
console.log(`${"total".padEnd(20)} ${n} tools`);
