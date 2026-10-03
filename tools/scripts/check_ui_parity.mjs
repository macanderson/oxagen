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
 *     The v2 descriptors under contracts/v2 are read too (computeV2Gaps). A
 *     v2 tool is not registered until cutover, so it has no binding of its
 *     own, but an "app" layer on it is still a promise, and a v1 contract that
 *     declares "app" must carry it until then.
 *
 *     One capability can be operable from more than one page: a run is paused
 *     from the run's own page and from its row on Fleet, and both are surfaces
 *     a person uses. The registry holds one object per capability, so the
 *     second page and every page after it go in that object's `also` array,
 *     and each entry is held to the same bar as the primary binding: a `page`
 *     that exists on disk and a `proof`. Without that, a second surface is
 *     either invisible to the gate or forces a duplicate key the registry
 *     cannot hold.
 *
 *   REVERSE (advisory — always warn-only):
 *     A registered capability that apps/app actually calls (an invoke() call,
 *     or a kernelRead or kernelWrite call in server code, which is how the
 *     rebuilt app reaches every contract) but that does NOT declare the "app" layer is
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
import { APP_DIR } from "./lib/app-dir.mjs";

const ARGS = new Set(process.argv.slice(2));
const JSON_MODE = ARGS.has("--json");
const STRICT = ARGS.has("--strict");
const info = JSON_MODE ? () => {} : (...a) => console.log(...a);

const ROOT = resolve(process.cwd());
const CAP_DIR = join(ROOT, "packages/oxagen/src/contracts");
/** The Appendix E descriptors staged for cutover (contracts/v2/_define.ts). */
const V2_DIR = join(CAP_DIR, "v2");
const REGISTRY = join(ROOT, APP_DIR, "capability-ui-map.json");
/**
 * The rebuilt app's own registry. During the app rebuild the
 * gates still point at the deprecated app (lib/app-dir.mjs), but a capability
 * whose UI now lives in apps/app is bound there, not here — so both are read
 * and a name the new app binds wins. The cutover batch flips APP_DIR and
 * deletes the deprecated registry, and this constant becomes REGISTRY.
 */
const REBUILT_REGISTRY = join(ROOT, "apps/app", "capability-ui-map.json");
const BASELINE = join(ROOT, APP_DIR, "capability-ui-parity-baseline.json");
const APP_SRC = join(ROOT, APP_DIR, "src");

// ── Contract parsing (kept byte-compatible with check_manifest.mjs) ──────────
/**
 * One contract file read as `{ file, name, layers, hasRegister, ident }`.
 *
 * Every field pattern is anchored to the start of a line. A contract's prose
 * is JSDoc, and a JSDoc line begins with `*`, so anchoring is what keeps a
 * sentence out of the registry: `run.list.ts` documents its operator fields
 * with "a person whose user record carries no name: `operatorKind` is what
 * separates them", and an unanchored `name:` match read `operatorKind` as
 * the capability's name. The checker then demanded a page for a capability
 * that does not exist and failed `--strict` on a contract nobody had
 * touched.
 *
 * Exported so the parse can be tested without a contracts directory.
 *
 * @param {string} file - the contract's filename, used as the fallback name
 * @param {string} src - the file's source
 */
export function parseContract(file, src) {
  // Anchored to the registerCapability(...) call, not only to a line start.
  // `^\\s*name:` stops the run.list.ts doc comment, whose line begins " * ",
  // but not an object literal elsewhere in the file whose own `name:` starts
  // a line — and a contract file is mostly schemas with defaults. These are
  // fields of that call, so the call is where they are read from.
  const declStart = src.search(/registerCapability\s*\(/);
  const decl = declStart === -1 ? "" : src.slice(declStart);
  const nameMatch = decl.match(/^\s*name:\s*["'`]([^"'`]+)["'`]/m);
  const layersMatch = decl.match(/^\s*layers:\s*\[([^\]]*)\]/m);
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
}

/** The quoted strings in an array literal's body, wrapped across lines or not. */
function quotedList(body) {
  return [...body.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
}

/**
 * One v2 descriptor read as `{ file, name, layers, absorbs }`, or null for a
 * file that defines no tool.
 *
 * A v2 module exports `const <ident> = defineTool({...})` and never calls
 * registerCapability (contracts/v2/_define.ts), so parseContract reads none
 * of it. The fields are read from the defineTool call, anchored to a line
 * start for the reason parseContract gives. A descriptor that composes a
 * field from its live contract (`layers: live.layers`) declares nothing of
 * its own for that field, and the live contract's own check covers it.
 *
 * Exported so the parse can be tested without a contracts directory.
 *
 * @param {string} file - the descriptor's filename, used as the fallback name
 * @param {string} src - the file's source
 */
export function parseV2Tool(file, src) {
  const declStart = src.search(/=\s*defineTool\s*\(/);
  if (declStart === -1) return null;
  const decl = src.slice(declStart);
  const nameMatch = decl.match(/^\s*name:\s*["'`]([^"'`]+)["'`]/m);
  const layersMatch = decl.match(/^\s*layers:\s*\[([^\]]*)\]/m);
  const absorbsMatch = decl.match(/^\s*absorbs:\s*\[([^\]]*)\]/m);
  return {
    file,
    name: nameMatch ? nameMatch[1] : file.replace(/\.ts$/, ""),
    layers: layersMatch ? quotedList(layersMatch[1]) : [],
    absorbs: absorbsMatch ? quotedList(absorbsMatch[1]) : [],
  };
}

function readV2Tools() {
  if (!existsSync(V2_DIR)) return [];
  return readdirSync(V2_DIR)
    .filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("_"),
    )
    .map((file) => parseV2Tool(file, readFileSync(join(V2_DIR, file), "utf8")))
    .filter((tool) => tool !== null);
}

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
    .map((file) =>
      parseContract(file, readFileSync(join(CAP_DIR, file), "utf8")),
    )
    .filter((c) => c.hasRegister);
}

// ── Registry ─────────────────────────────────────────────────────────────────
function readBindings(file, required) {
  if (!existsSync(file)) {
    if (!required) return {};
    console.error(`No UI binding registry at ${file}.`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")).bindings ?? {};
  } catch (e) {
    console.error(`${file} is not valid JSON: ${e.message}`);
    process.exit(2);
  }
}

function readRegistry() {
  return {
    ...readBindings(REGISTRY, true),
    ...(REBUILT_REGISTRY === REGISTRY
      ? {}
      : readBindings(REBUILT_REGISTRY, false)),
  };
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
 * Set of capability names invoked by app code. The app calls capabilities in
 * four shapes:
 *   invoke("<name>", ...)                        a string literal (rare)
 *   invoke(<ident>.name, ...)                    the imported contract's .name
 *   kernelRead(ctx, { contract: <ident>, ... })  every server read in apps/app
 *   kernelWrite(ctx, <ident>, input)             every server write in apps/app
 * We resolve the identifier shapes through identToName (built from each
 * contract's `export const <ident> = registerCapability({ name: ... })`).
 *
 * The kernel shapes matter most. apps/app reaches contracts through
 * `src/server/kernel.ts`, not through invoke(), so a scan for invoke() alone
 * missed every read and write the app makes. The Steering page read
 * get_steering_freshness with no "app" layer, and nothing reported it.
 *
 * A `contract:` key is matched anywhere in the source, because a read's call
 * object can be built before the kernelRead call that takes it. An identifier
 * that is not a registered contract, such as the `ReadContract` type in a
 * signature, resolves to nothing.
 *
 * @param {Set<string>} validNames - registered capability names
 * @param {Map<string,string>} identToName - contract ident → capability name
 */
export function resolveInvoked(src, validNames, identToName) {
  const found = new Set();
  const LITERAL = /invoke\(\s*["'`]([a-zA-Z][\w.]+)["'`]/g;
  const IDENT = /invoke\(\s*(\w+)\.name\b/g;
  const READ = /\bcontract:\s*(\w+)\b/g;
  const WRITE = /\bkernelWrite(?:<[^>()]*>)?\(\s*[^,()]+,\s*(\w+)\b/g;
  let m;
  while ((m = LITERAL.exec(src))) {
    if (validNames.has(m[1])) found.add(m[1]);
  }
  for (const pattern of [IDENT, READ, WRITE]) {
    while ((m = pattern.exec(src))) {
      const name = identToName.get(m[1]);
      if (name && validNames.has(name)) found.add(name);
    }
  }
  return found;
}

/**
 * One bound surface judged by the same two rules as any other: its `page`
 * exists on disk and it carries a runtime `proof`. Returns the reason it
 * fails, or null.
 *
 * @param {{page?:string, proof?:string}} surface
 * @param {(p:string)=>boolean} pageExists
 * @param {string} label - what to call the surface in the reason ("binding", "binding.also[0]")
 */
function surfaceGap(surface, pageExists, label) {
  if (!surface.page || !pageExists(surface.page))
    return `${label}.page missing on disk: ${surface.page ?? "(unset)"}`;
  if (!surface.proof)
    return `${label} has no runtime \`proof\` (screenshot under verifications/ or an e2e spec)`;
  return null;
}

/**
 * The `also` array: the second and later pages one capability is operated on.
 *
 * The registry holds one object per capability name, so a capability a person
 * reaches from two places (create_enrollment_token from the register flow and
 * from an agent's Enrollment tab) could only be recorded once. A duplicate key
 * is not an option: JSON keeps the last one and the first page silently
 * stops being checked. So the extra pages go in `also`, and each entry is held to
 * the same bar as the primary binding: a page that exists and a proof that
 * names it. An `also` that is not an array is itself the gap, because a
 * mistyped binding that is quietly skipped is how a dead surface looks done.
 *
 * @param {{also?:unknown}} binding
 * @param {(p:string)=>boolean} pageExists
 */
function alsoGap(binding, pageExists) {
  const { also } = binding;
  if (also === undefined) return null;
  if (!Array.isArray(also)) return "binding.also is not an array";
  for (const [i, surface] of also.entries()) {
    if (typeof surface !== "object" || surface === null)
      return `binding.also[${i}] is not an object`;
    const gap = surfaceGap(surface, pageExists, `binding.also[${i}]`);
    if (gap) return gap;
  }
  return null;
}

/**
 * The v2 descriptors' half of the FORWARD law.
 *
 * A v2 tool is staged beside the v1 contracts it absorbs and is wired into the
 * registry at cutover (#2884), so until then nothing invokes it and it has no
 * binding of its own. Its "app" layer is still a promise. Until cutover a v1
 * contract carries it: the live contract of the same name, or one the tool
 * absorbs, that declares "app" itself and so is held to a binding by the v1
 * check. A v2 tool that declares "app" with no such carrier promises a page
 * that nothing in the app operates: ADR-081 retired the layer on its sources
 * and the descriptor kept it. That is a gap like any other, so back it or drop
 * the layer.
 *
 * A carrier with no binding is reported once, by the v1 check, and not here.
 * A gap is named `v2:<name>`, so a v1 name in the baseline never hides it.
 *
 * @param {{tools:Array, caps:Array}} args
 */
export function computeV2Gaps({ tools, caps }) {
  const promised = new Set(
    caps.filter((c) => c.layers.includes("app")).map((c) => c.name),
  );
  const gaps = [];
  for (const tool of tools) {
    if (!tool.layers.includes("app")) continue;
    const carriers = [tool.name, ...tool.absorbs].filter((n) =>
      promised.has(n),
    );
    if (carriers.length > 0) continue;
    gaps.push({
      capability: `v2:${tool.name}`,
      reason: `contracts/v2/${tool.file} declares 'app', but neither ${tool.name} nor a contract it absorbs (${tool.absorbs.join(", ") || "none"}) declares 'app' to carry it until cutover`,
    });
  }
  return gaps;
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
 * `v2Tools` are the parsed v2 descriptors; their gaps (computeV2Gaps) join
 * `forward` after the v1 ones. It defaults to none.
 *
 * @param {{caps:Array, bindings:Object, invoked:Set<string>, pageExists:(p:string)=>boolean, baseline?:Set<string>, v2Tools?:Array}} args
 */
export function computeParity({
  caps,
  bindings,
  invoked,
  pageExists,
  baseline = new Set(),
  v2Tools = [],
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
    const gap = surfaceGap(b, pageExists, "binding");
    if (gap) {
      forward.push({ capability: cap.name, reason: gap });
      continue;
    }
    const extra = alsoGap(b, pageExists);
    if (extra) forward.push({ capability: cap.name, reason: extra });
  }
  forward.push(...computeV2Gaps({ tools: v2Tools, caps }));
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
 * True for a file that ships in the app. A test, and the deliberately broken
 * probes under `src/test/` that the architecture tests read, are not a surface
 * a person operates, so a contract they name is not one the app calls.
 *
 * Exported so the two scan paths can be tested to agree.
 *
 * @param {string} path
 */
export function isAppSource(path) {
  const p = path.replaceAll("\\", "/");
  if (!/\.(ts|tsx)$/.test(p)) return false;
  if (/\.(test|spec)\.tsx?$/.test(p)) return false;
  return !/(^|\/)src\/test\//.test(p);
}

/**
 * The rg pattern that picks which app files resolveInvoked reads. It must
 * match every call shape resolveInvoked resolves, or rg drops the file before
 * the resolver sees it while the directory walk, which reads every file,
 * still finds it. Exported so a test holds the two together.
 */
export const APP_SOURCE_PATTERN = "invoke\\(|contract:|kernelWrite";

/**
 * Concatenated source of every shipping .ts/.tsx under apps/app/src that
 * mentions `invoke(`, `contract:`, or `kernelWrite`, found via rg when it is
 * available and a directory walk otherwise.
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
        APP_SOURCE_PATTERN,
        APP_SRC,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\n")
      .filter(Boolean)
      .filter(isAppSource);
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
      else if (isAppSource(p)) {
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
  const v2Tools = readV2Tools();
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
    v2Tools,
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
    `UI parity: ${caps.length} capabilities, ${v2Tools.length} v2 tools, ${Object.keys(bindings).length} bindings, ${invoked.size} app-invoked, ${grandfathered} grandfathered.`,
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
