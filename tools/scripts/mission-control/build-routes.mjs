// Appendix F: map the 70 live route files onto the 10 surviving pages.
// Produces the route deletion manifest + the keep-list.
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const SPEC = readFileSync(process.argv[2], "utf8");
const APP = process.argv[3];
const OUT = process.argv[4];

// --- live routes ---
const files = execSync(`fd -g 'page.tsx' ${APP}`, { encoding: "utf8" })
  .trim()
  .split("\n");

// src/app/[orgSlug]/settings/github/page.tsx -> [orgSlug]/settings/github
const routeOf = (f) =>
  f
    .replace(/.*src\/app\//, "")
    .replace(/\/page\.tsx$/, "")
    .replace(/\((\w|-)+\)\//g, ""); // strip route groups like (auth)/

const routes = files.map((f) => ({ file: f, route: routeOf(f) }));

// --- Appendix F table ---
const lines = SPEC.split("\n");
const fStart = lines.findIndex((l) => l.startsWith("## Appendix F."));
const pages = [];
for (const line of lines.slice(fStart)) {
  const m = /^\|\s*(\d+)\s*\|\s*\*\*(.+?)\*\*\s*\|([^|]*)\|([^|]*)\|/.exec(line);
  if (!m) continue;
  const absorbs = m[4]
    .split(",")
    .map((s) => s.trim().replace(/`/g, ""))
    .filter(Boolean);
  pages.push({ n: Number(m[1]), page: m[2], route: m[3].trim().replace(/`/g, ""), absorbs });
}

// auth + callback routes are explicitly out of scope per Appendix F prose
const EXEMPT = /^(login|signup|forgot-password|reset-password|two-factor|verify|accept-invite|new-organization|cli\/authorize|github\/setup)/;

const classified = routes.map((r) => {
  if (EXEMPT.test(r.route)) return { ...r, verdict: "exempt", page: "sign-in / callback" };
  // does any surviving page claim this route?
  const owner = pages.find((p) =>
    p.absorbs.some((a) => {
      const norm = a.replace(/\[ws\]|\[orgSlug\]|\[workspaceSlug\]/g, "").replace(/^\//, "");
      return norm && r.route.includes(norm.replace(/\*$/, ""));
    }),
  );
  return { ...r, verdict: owner ? "absorbed" : "unclaimed", page: owner?.page ?? null };
});

const absorbed = classified.filter((c) => c.verdict === "absorbed");
const unclaimed = classified.filter((c) => c.verdict === "unclaimed");
const exempt = classified.filter((c) => c.verdict === "exempt");

writeFileSync(OUT, JSON.stringify({ pages, classified }, null, 2));

console.log(`=== Appendix F ===`);
console.log(`surviving pages parsed:  ${pages.length}`);
console.log(`live route files:        ${routes.length}`);
console.log(``);
console.log(`absorbed by a survivor:  ${absorbed.length}`);
console.log(`sign-in / callback:      ${exempt.length}  (stay as-is)`);
console.log(`unclaimed:               ${unclaimed.length}  <- needs a human call`);
console.log(``);
console.log(`--- unclaimed routes ---`);
for (const u of unclaimed) console.log(`  ${u.route}`);
