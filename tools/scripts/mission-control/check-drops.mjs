// Validate the computed deletion manifest against Appendix E's explicit
// "Dropped, by family" paragraph. Agreement means the deletion needs no
// judgment call; disagreement is exactly where a human has to look.
import { readFileSync } from "node:fs";

const SPEC = readFileSync(process.argv[2], "utf8");
const orphans = JSON.parse(readFileSync(process.argv[3], "utf8"));

const para = SPEC.split("\n").find((l) => l.startsWith("**Dropped, by family**"));
if (!para) throw new Error("could not find the Dropped-by-family paragraph");

// Names appear as `name` or `name.*` or `bind/unbind_agent_environment`.
const named = new Set();
for (const m of para.matchAll(/`([^`]+)`/g)) {
  const tok = m[1];
  if (tok.endsWith(".*")) named.add(`PREFIX:${tok.slice(0, -2)}`);
  else if (tok.includes("/")) {
    // bind/unbind_agent_environment -> bind_agent_environment, unbind_agent_environment
    const [a, rest] = tok.split("/");
    const suffix = rest.replace(/^[a-z]+_/, "");
    named.add(`${a}_${suffix}`);
    named.add(rest);
  } else named.add(tok);
}

const prefixes = [...named].filter((n) => n.startsWith("PREFIX:")).map((n) => n.slice(7));
const exact = new Set([...named].filter((n) => !n.startsWith("PREFIX:")));

const covered = (o) =>
  exact.has(o.name) ||
  prefixes.some((p) => o.domain === p || o.name.startsWith(`${p}_`) || o.file.startsWith(`${p}.`));

const confirmed = orphans.filter(covered);
const unconfirmed = orphans.filter((o) => !covered(o));

console.log(`orphans computed from the matrix:        ${orphans.length}`);
console.log(`explicitly dropped by Appendix E prose:  ${confirmed.length}`);
console.log(`NOT named in the drop paragraph:         ${unconfirmed.length}`);
console.log(`\n--- needs a human call ---`);
for (const o of unconfirmed) console.log(`  ${o.name.padEnd(30)} ${o.file}`);
