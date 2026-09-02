#!/usr/bin/env node
/**
 * check_ui_parity.mjs — enforce the "UI Capability Parity" law.
 *
 * Sibling to check_manifest.mjs. Where check_manifest verifies that a declared
 * layer has a FILE on disk, this verifies the one layer a file-existence check
 * cannot honestly cover: the "app" layer, i.e. "a human can actually operate
 * this capability in apps/app". The failure mode this closes: an agent builds
 * the api + mcp + cli layers, claims the feature "works in the app", and ships
 * a page that 404s / throws / was never wired — a dead surface that looks done.
 *
 * The law has two directions:
 *
 *   FORWARD (gate — can fail with --strict):
 *     A capability whose contract layers[] includes "app" MUST have a binding
 *     in apps/app/capability-ui-map.json, and that binding's `page` file MUST
 *     exist. (The runtime "renders without an error page" half is proven by the
 *     binding's screenshot/e2e `proof`, captured by the wiring agent — this
 *     script verifies the static half; CI e2e + the committed proof verify the
 *     runtime half.)
 *
 *   REVERSE (advisory — always warn-only):
 *     A registered capability that apps/app actually invokes (a literal
 *     invoke("<name>") call) but that does NOT declare the "app" layer is
 *     flagged — either it needs the promise + a binding, or the invoke is
 *     internal plumbing that should be documented as such. Advisory because
 *     mid-stream agent capabilities are legitimately invoked without being a
 *     discrete human UI surface.
 *
 * Output modes (match check_manifest.mjs):
 *   (default)  warn-only — gaps print as ::warning:: annotations, exit 0.
 *   --strict   FORWARD gaps fail the process (exit 1). Reverse stays advisory.
 *   --json     emit { forward:[...], reverse:[...] } to stdout, exit 0.
 *
 * A structural error (no contracts dir, unparseable registry) hard-fails
 * (exit 2) — that's a broken repo, not an incomplete feature.
 */
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ARGS = new Set(process.argv.slice(2));
const JSON_MODE = ARGS.has("--json");
const STRICT = ARGS.has("--strict");
const info = JSON_MODE ? () => {} : (...a) => console.log(...a);

const ROOT = resolve(process.cwd());
const CAP_DIR = join(ROOT, "packages/oxagen/src/contracts");
const REGISTRY = join(ROOT, "apps/app/capability-ui-map.json");
const BASELINE = join(ROOT, "apps/app/capability-ui-parity-baseline.json");
const APP_SRC = join(ROOT, "apps/app/src");

// ── Contract parsing (kept byte-compatible with check_manifest.mjs) ──────────
function readCapabilities() {
  if (!existsSync(CAP_DIR)) {
    console.error(`No capabilities dir at ${CAP_DIR}.`);
    process.exit(2);
  }
  return readdirSync(CAP_DIR)
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        f !== "index.ts" &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".handler.ts"),
    )
    .map((file) => {
      const src = readFileSync(join(CAP_DIR, file), "utf8");
      const nameMatch = src.match(/name:\s*["'`]([^"'`]+)["'`]/);
      const layersMatch = src.match(/layers:\s*\[([^\]]*)\]/);
      // The exported identifier bound to registerCapability(...) — this is what
      // app code imports and invokes as `invoke(<ident>.name, ...)`.
      const identMatch = src.match(
        /export const (\w+)\s*=\s*registerCapability\s*\(/,
      );
      const name = nameMatch ? nameMatch[1] : file.replace(/\.ts$/, "");
      const layers = layersMatch
        ? layersMatch[1]
            .split(",")
            .map((s) => s.trim().replace(/["'`]/g, ""))
            .filter(Boolean)
        : [];
      const hasRegister = /registerCapability\s*\(/.test(src);
      const ident = identMatch ? identMatch[1] : null;
      return { file, name, layers, hasRegister, ident };
    })
    .filter((c) => c.hasRegister);
}

// ── Registry ─────────────────────────────────────────────────────────────────
function readRegistry() {
  if (!existsSync(REGISTRY)) {
    console.error(`No UI binding registry at ${REGISTRY}.`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(REGISTRY, "utf8"));
  } catch (e) {
    console.error(`capability-ui-map.json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  return parsed.bindings ?? {};
}

// ── Ratchet baseline ──────────────────────────────────────────────────────────
// The set of capability names whose FORWARD gaps are grandfathered (known
// pre-existing debt). --strict fails only on gaps NOT in this set. Missing file
// = empty baseline (every gap blocks), which is the strictest, safest default.
function readBaseline() {
  if (!existsSync(BASELINE)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(BASELINE, "utf8"));
    return new Set(parsed.grandfathered ?? []);
  } catch (e) {
    console.error(
      `capability-ui-parity-baseline.json is not valid JSON: ${e.message}`,
    );
    process.exit(2);
  }
}

/**
 * Set of capability names invoked by app code. The app invokes capabilities in
 * two shapes:
 *   invoke("<name>", ...)          — a string literal (rare)
 *   invoke(<ident>.name, ...)      — the imported contract's .name (common),
 *                                    e.g. invoke(apiKeyCreate.name, ...)
 * We resolve the second shape through identToName (built from each contract's
 * `export const <ident> = registerCapability({ name: ... })`).
 *
 * @param {Set<string>} validNames - registered capability names
 * @param {Map<string,string>} identToName - contract ident → capability name
 */
export function resolveInvoked(src, validNames, identToName) {
  const found = new Set();
  const LITERAL = /invoke\(\s*["'`]([a-zA-Z][\w.]+)["'`]/g;
  const IDENT = /invoke\(\s*(\w+)\.name\b/g;
  let m;
  while ((m = LITERAL.exec(src))) {
    if (validNames.has(m[1])) found.add(m[1]);
  }
  while ((m = IDENT.exec(src))) {
    const name = identToName.get(m[1]);
    if (name && validNames.has(name)) found.add(name);
  }
  return found;
}

/**
 * Pure parity computation. Given parsed contracts, the registry bindings, the
 * set of app-invoked names, and a `pageExists` predicate (injected so tests
 * need no disk), return { forward, reverse, blocking } gap lists.
 *
 * `baseline` is the ratchet: a Set of capability names whose forward gaps are
 * grandfathered (known pre-existing debt). `blocking` is the subset of
 * `forward` gaps that are NOT baselined — those are the ones --strict fails on.
 * `forward` still lists EVERY gap (baselined or not) so --json/warn output keeps
 * the full debt visible. `baseline` defaults to empty, so callers that omit it
 * get `blocking === forward` (backward compatible).
 *
 * @param {{caps:Array, bindings:Object, invoked:Set<string>, pageExists:(p:string)=>boolean, baseline?:Set<string>}} args
 */
export function computeParity({
  caps,
  bindings,
  invoked,
  pageExists,
  baseline = new Set(),
}) {
  const byName = new Map(caps.map((c) => [c.name, c]));
  const forward = [];
  for (const cap of caps) {
    if (!cap.layers.includes("app")) continue;
    const b = bindings[cap.name];
    if (!b) {
      forward.push({
        capability: cap.name,
        reason:
          "declares 'app' layer but has no binding in capability-ui-map.json",
      });
      continue;
    }
    if (!b.page || !pageExists(b.page)) {
      forward.push({
        capability: cap.name,
        reason: `binding.page missing on disk: ${b.page ?? "(unset)"}`,
      });
      continue;
    }
    if (!b.proof) {
      forward.push({
        capability: cap.name,
        reason:
          "binding has no runtime `proof` (screenshot under verifications/ or an e2e spec)",
      });
    }
  }
  const blocking = forward.filter((g) => !baseline.has(g.capability));
  const reverse = [];
  for (const name of invoked) {
    const cap = byName.get(name);
    if (!cap) continue;
    if (!cap.layers.includes("app")) {
      reverse.push({
        capability: name,
        reason:
          "invoked by apps/app but contract does not declare the 'app' layer",
      });
    } else if (!bindings[name]) {
      reverse.push({
        capability: name,
        reason: "invoked by apps/app and declares 'app' but has no binding",
      });
    }
  }
  return { forward, reverse, blocking };
}

/**
 * Concatenated source of every .ts/.tsx under apps/app/src that mentions
 * `invoke(`, found via rg when it is available and a directory walk otherwise.
 *
 * rg narrows which FILES to read, never which lines: the formatter wraps long
 * calls, so `invoke(\n  listAgents.name, …)` puts the call and its argument on
 * different lines and a line-oriented match would drop every one of them (there
 * are a dozen such sites in apps/app today). Both paths must hand resolveInvoked
 * whole files, or the fast path silently under-reports.
 */
function readAppSource() {
  let paths;
  try {
    paths = execFileSync(
      "rg",
      [
        "-l",
        "--no-messages",
        "-g",
        "*.ts",
        "-g",
        "*.tsx",
        "invoke\\(",
        APP_SRC,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    return walkGrep(APP_SRC);
  }
  let out = "";
  for (const p of paths) {
    try {
      out += readFileSync(p, "utf8") + "\n";
    } catch {
      /* ignore */
    }
  }
  return out;
}

function walkGrep(dir) {
  let out = "";
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        try {
          out += readFileSync(p, "utf8") + "\n";
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out;
}

function main() {
  const caps = readCapabilities();
  const bindings = readRegistry();
  const baseline = readBaseline();
  const validNames = new Set(caps.map((c) => c.name));
  const identToName = new Map(
    caps.filter((c) => c.ident).map((c) => [c.ident, c.name]),
  );

  const invoked = resolveInvoked(readAppSource(), validNames, identToName);
  const { forward, reverse, blocking } = computeParity({
    caps,
    bindings,
    invoked,
    baseline,
    pageExists: (p) => existsSync(join(ROOT, p)),
  });

  if (JSON_MODE) {
    process.stdout.write(
      JSON.stringify({ forward, reverse, blocking }, null, 2) + "\n",
    );
    return;
  }

  const grandfathered = forward.length - blocking.length;
  info(
    `UI parity: ${caps.length} capabilities, ${Object.keys(bindings).length} bindings, ${invoked.size} app-invoked, ${grandfathered} grandfathered.`,
  );

  for (const g of reverse) {
    console.log(
      `::warning title=UI parity (advisory)::${g.capability} — ${g.reason}`,
    );
  }
  if (reverse.length) {
    console.error(
      `\nADVISORY — ${reverse.length} capability(ies) invoked by the app without an 'app'-layer promise:`,
    );
    for (const g of reverse) console.error(`  - ${g.capability}: ${g.reason}`);
  }

  if (forward.length) {
    // `blocking` is the NON-grandfathered subset, so this set names the gaps
    // that fail the build — not the baselined ones.
    const blockingNames = new Set(blocking.map((g) => g.capability));
    for (const g of forward) {
      // Blocking gaps annotate as ::error:: under --strict so they surface loudly;
      // grandfathered gaps stay ::warning:: (tracked debt, not a build failure).
      const isBlocking = blockingNames.has(g.capability);
      const level = isBlocking && STRICT ? "error" : "warning";
      const tag = isBlocking
        ? "UI parity gap"
        : "UI parity gap (grandfathered)";
      console.log(`::${level} title=${tag}::${g.capability} — ${g.reason}`);
    }
    if (grandfathered) {
      console.error(
        `\nGRANDFATHERED — ${grandfathered} pre-existing 'app'-layer gap(s) in capability-ui-parity-baseline.json (shrink this list as Phases 1-6 add each page's proof):`,
      );
    }
    if (blocking.length) {
      console.error(
        `\nUI PARITY GAPS — ${blocking.length} NEW 'app'-layer capability(ies) not backed by a working, proven page:`,
      );
      for (const g of blocking)
        console.error(`  - ${g.capability}: ${g.reason}`);
      if (STRICT) {
        console.error(
          "\n--strict: failing because non-grandfathered forward UI-parity gaps exist. Back the page (binding + proof) or drop the 'app' layer — do NOT add it to the baseline.",
        );
        process.exit(1);
      }
      console.error(
        "\n(warn-only — pass --strict to fail. A declared 'app' layer is a promise; back it or drop it.)",
      );
    }
    return;
  }

  info(
    "UI Capability Parity: all 'app'-layer capabilities are bound to a working page.",
  );
}

// Only run when executed directly (not when imported by the test).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
