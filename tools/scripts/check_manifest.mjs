#!/usr/bin/env node
/**
 * check_manifest.mjs — regenerate the capability manifest and report any
 * declared layer that has no file on disk.
 *
 * Output modes:
 *   (default)   warn-only — gaps print as GitHub `::warning::` annotations and
 *               the process exits 0. Incomplete, in-progress capabilities (a
 *               normal mid-phase state) therefore do NOT fail CI. The gaps are
 *               instead tracked in Linear by tools/scripts/ensure-manifest-tickets.ts.
 *   --strict    restore the old behaviour — exit 1 if any gap exists (use when
 *               you want a hard completeness gate, e.g. a release cut).
 *   --json      emit the gaps as JSON to stdout ({ gaps: [{ capability, missing[] }] })
 *               and suppress the human logs. Consumed by the ticketer. Exit 0.
 *
 * A structural error (no contracts dir) always hard-fails (exit 2) regardless
 * of mode — that's a broken repo, not an incomplete feature.
 *
 * Layer→path map matches this monorepo's layout (not the skill template's
 * placeholder Next.js single-app layout).
 */
import { readdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_DIR } from "./lib/app-dir.mjs";

const ARGS = new Set(process.argv.slice(2));
const JSON_MODE = ARGS.has("--json");
const STRICT = ARGS.has("--strict");

// In --json mode stdout must be pure JSON for the ticketer, so silence the
// human-readable progress logs.
const info = JSON_MODE ? () => {} : (...a) => console.log(...a);

const ROOT = resolve(process.cwd());
const CAP_DIR = join(ROOT, "packages/oxagen/src/contracts");
const MANIFEST = join(ROOT, "packages/oxagen/capabilities.manifest.json");
const BARREL = join(ROOT, "packages/oxagen/src/contracts.generated.ts");

function slugify(name) {
  return name.replace(/\./g, "-");
}

// ── Combined-route content scan ───────────────────────────────────────────────
// Several api routes dispatch MANY capabilities from one file (e.g. schema.ts
// mounts 22 schema.* capabilities). A per-capability filename check alone can
// never see those — it needs to look INSIDE the route files for evidence that
// each capability is actually wired. Built once and cached: reading ~266 route
// files per capability would be O(files × capabilities) instead of O(files).
const CONTRACT_IMPORT_RE =
  /from\s*["']@oxagen\/oxagen\/contracts\/([^"']+)["']/g;

/**
 * Pure indexer: given the raw contents of every apps/api/src/routes/v1/*.ts
 * file, return the set of contract stems any of them import, the
 * concatenated source, and that source with its comments removed (`code`, for
 * the dispatch-by-name fallback scan). No filesystem access, so it's directly
 * unit-testable.
 *
 * @param {{name: string, content: string}[]} files
 */
export function buildApiRouteIndex(files) {
  const importedStems = new Set();
  let content = "";
  for (const { content: src } of files) {
    CONTRACT_IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = CONTRACT_IMPORT_RE.exec(src))) importedStems.add(m[1]);
    content += src + "\n";
  }
  return { importedStems, content, code: stripComments(content) };
}

/**
 * Remove block and line comments from TypeScript source so a scan sees only
 * code. A route file often explains itself in a comment such as
 * `invoke("get_run")`, and that sentence dispatches nothing. The line-comment
 * rule skips `//` preceded by a colon, a quote, or a backslash, so a URL
 * inside a string literal survives.
 *
 * @param {string} src
 */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * Whether route code dispatches `capName` by its registered name, that is,
 * passes it as a string literal in the first argument of `invoke(...)`, the
 * kernel's one dispatch path. A name that appears anywhere else (a log
 * message, an error string, a comment) is not wiring.
 *
 * @param {string} code - route source with comments removed
 * @param {string} capName
 */
export function dispatchesByName(code, capName) {
  const name = capName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\binvoke\\s*\\(\\s*(["'\`])${name}\\1\\s*[,)]`).test(
    code,
  );
}

/**
 * Pure evidence check for the "api" layer. Primary evidence (a dedicated
 * per-capability route file) is resolved by the caller via `hasDirectFile` so
 * this function needs no disk access to test. Fallback evidence (dispatched
 * from a combined multi-capability route file) is either of:
 *   - the capability's contract module is imported by some route file
 *     (`from ".../contracts/<stem>"`, matched against either candidate stem)
 *   - route code dispatches the capability by its exact registered name,
 *     `invoke("<name>", ...)` (covers dispatch sites where the imported
 *     identifier doesn't textually match either stem). The name quoted
 *     anywhere else, such as a comment or a log string, does not count.
 *
 * @param {{stems: string[], capName: string, hasDirectFile: boolean, routeIndex: {importedStems: Set<string>, content: string, code?: string}}} args
 */
export function apiLayerSatisfied({
  stems,
  capName,
  hasDirectFile,
  routeIndex,
}) {
  if (hasDirectFile) return true;
  if (stems.some((s) => routeIndex.importedStems.has(s))) return true;
  return dispatchesByName(
    routeIndex.code ?? stripComments(routeIndex.content),
    capName,
  );
}

/**
 * Pure evidence check for the "cli" layer. The CLI groups its commands by
 * noun (`run.ts` carries `oxagen run export`, `export-status`, `download`
 * and `chain`; `repo.ts` carries the repository commands), so a per-capability
 * filename exists for almost nothing. A capability is wired when it declares
 * "cli" in surfaces[] and either a dedicated command file exists or some
 * command file names the capability, by its registered name in a string or
 * a backtick, or by importing its contract. Before this the layer had no
 * rule at all, so declaring it reported a gap for every capability that
 * carried it, and none did.
 *
 * @param {{stems: string[], capName: string, capSurfaces: string[], hasDirectFile: boolean, commandIndex: {importedStems: Set<string>, content: string}}} args
 */
export function cliLayerSatisfied({
  stems,
  capName,
  capSurfaces,
  hasDirectFile,
  commandIndex,
}) {
  if (!capSurfaces.includes("cli")) return false;
  if (hasDirectFile) return true;
  if (stems.some((s) => commandIndex.importedStems.has(s))) return true;
  return (
    commandIndex.content.includes(`"${capName}"`) ||
    commandIndex.content.includes(`'${capName}'`) ||
    commandIndex.content.includes(`\`${capName}\``)
  );
}

let cliCommandIndexCache = null;
function getCliCommandIndex() {
  if (cliCommandIndexCache) return cliCommandIndexCache;
  const dir = join(ROOT, "apps/cli/src/commands");
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => ({ name: f, content: readFileSync(join(dir, f), "utf8") }))
    : [];
  cliCommandIndexCache = buildApiRouteIndex(files);
  return cliCommandIndexCache;
}

let apiRouteIndexCache = null;
function getApiRouteIndex() {
  if (apiRouteIndexCache) return apiRouteIndexCache;
  const dir = join(ROOT, "apps/api/src/routes/v1");
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => ({ name: f, content: readFileSync(join(dir, f), "utf8") }))
    : [];
  apiRouteIndexCache = buildApiRouteIndex(files);
  return apiRouteIndexCache;
}

// Regenerate the contract barrel from the contents of ./contracts. This is the
// auto-discovery that replaces the old hand-maintained import list in
// index.ts: adding a contract file is enough to register it, and a stale
// barrel is impossible because the gate rewrites it on every run.
function writeContractBarrel(files) {
  const imports = files
    .map((f) => f.replace(/\.ts$/, ""))
    .sort()
    .map((base) => `import "./contracts/${base}";`)
    .join("\n");
  const body = [
    "// AUTO-GENERATED by tools/scripts/check_manifest.mjs — do not edit by hand.",
    "// Every contract file under ./contracts auto-registers on import; this barrel",
    "// is the single import that pulls them all in. Run `pnpm check:manifest`",
    "// (or the gate) to regenerate after adding or removing a contract.",
    "",
    imports,
    "",
  ].join("\n");
  writeFileSync(BARREL, body);
}

/**
 * Whether `manifest` differs from the manifest text already on disk by
 * content. The file is committed in Biome's format (arrays inline) and this
 * script serialises with JSON.stringify (arrays one element per line); writing
 * on every run left a formatting-only diff across the whole file after each
 * `pnpm check:manifest`. A file that does not parse counts as changed, so a
 * corrupt manifest is rewritten.
 */
export function manifestContentChanged(currentText, manifest) {
  let current;
  try {
    current = JSON.parse(currentText);
  } catch {
    return true;
  }
  return JSON.stringify(current) !== JSON.stringify(manifest);
}

/**
 * Returns true when the given layer is satisfied for a capability.
 *
 * The "mcp" layer is satisfied by TWO conditions both being true:
 *   1. The capability's surfaces[] includes "mcp" — enabling dynamic dispatch
 *      through the xmcp server's capabilitiesForSurface("mcp") + kernel.invoke().
 *   2. A per-tool file exists at apps/mcp/src/tools/<capability>.ts — the xmcp
 *      tool registration that maps the capability into the MCP protocol surface.
 *      As of this writing, 38+ such files exist and are actively used.
 *
 * The "api" layer is satisfied by a dedicated per-capability file at
 * apps/api/src/routes/v1/<stem>.ts OR by evidence inside a combined
 * multi-capability route file (schema.ts, connection.ts, integration.ts,
 * repo.ts, semantic-edge.ts, workflow.ts, plugin-schema.ts) —
 * see apiLayerSatisfied/buildApiRouteIndex above. Filename-only checking
 * cannot see those combined files' contents, so it used to falsely report
 * every capability they dispatch as an api gap.
 *
 * @param {string} layer - the layer name from the contract's layers[]
 * @param {string} capName - the capability name (e.g. "org.create")
 * @param {string[]} capSurfaces - the capability's surfaces[] array
 * @param {string} fileStem - the contract's own filename stem (e.g.
 *   "telemetry.error.cluster"). ADR-025 renamed capability NAMES to verb-first
 *   snake_case but the FILES kept their legacy dotted stems, so evidence files
 *   (api route, mcp tool, unit test, docs page) may be named by either — a
 *   capability whose surfaces all exist must never be reported as a gap just
 *   because the checker only tried the snake name (fix-the-checker rule).
 */
/**
 * capability name -> the `proof` path its apps/app UI binding records, for the
 * bindings whose proof is an e2e spec. Pure, so it can be tested without a
 * repo on disk.
 *
 * @param {unknown} parsed - the parsed apps/app/capability-ui-map.json
 * @returns {Map<string, string>}
 */
export function buildUiProofIndex(parsed) {
  const index = new Map();
  // The bindings live under a `bindings` key, beside the file's own `$doc` and
  // `$binding_shape` notes.
  const bindings = parsed?.bindings;
  if (bindings === null || typeof bindings !== "object") return index;
  for (const [name, binding] of Object.entries(bindings)) {
    const proof = binding?.proof;
    if (typeof proof === "string" && proof.endsWith(".spec.ts"))
      index.set(name, proof);
  }
  return index;
}

/** @returns {Map<string, string>} the index above, read from disk once. */
let uiProofIndex;
function getUiProofIndex() {
  if (uiProofIndex !== undefined) return uiProofIndex;
  const mapPath = join(ROOT, "apps/app/capability-ui-map.json");
  if (!existsSync(mapPath)) {
    uiProofIndex = new Map();
    return uiProofIndex;
  }
  try {
    uiProofIndex = buildUiProofIndex(JSON.parse(readFileSync(mapPath, "utf8")));
  } catch {
    // A malformed map is check:ui-parity's failure to report, not this one's.
    uiProofIndex = new Map();
  }
  return uiProofIndex;
}

function layerSatisfied(layer, capName, capSurfaces, fileStem) {
  const slug = slugify(capName);
  const stems =
    fileStem && fileStem !== capName ? [capName, fileStem] : [capName];
  // The mcp layer is satisfied when the capability declares "mcp" in surfaces[]
  // AND a tool file exists at apps/mcp/src/tools/<capability>.ts (xmcp registration).
  if (layer === "mcp") {
    if (!capSurfaces.includes("mcp")) return false;
    return stems.some((s) =>
      existsSync(join(ROOT, `apps/mcp/src/tools/${s}.ts`)),
    );
  }
  // The "app" layer (human-operable UI in apps/app) is not a file-existence
  // check — it is a route-binding + runtime-proof promise owned by a dedicated
  // gate, tools/scripts/check_ui_parity.mjs. Treat it as satisfied here so the
  // manifest doesn't report false "app missing" gaps; check:ui-parity is the
  // authority for app-surface completeness.
  if (layer === "app") return true;
  // The "e2e" layer had a filename-only check — apps/app/e2e/<slug>.spec.ts —
  // which names a spec after the capability. Real specs are named after the
  // screen they drive (fleet.spec.ts drives list_tacho_hosts), so a capability
  // with a real, passing e2e test was reported as an e2e gap and a ticket was
  // filed for a test that exists. The binding is already recorded, exactly and
  // by hand, in apps/app/capability-ui-map.json's `proof` field, which
  // check:ui-parity requires to point at a real artifact. Read that rather than
  // guess from the name; the filename convention still counts, for a capability
  // with no UI binding. Same fix-the-checker rule the api layer already carries.
  if (layer === "e2e") {
    if (existsSync(join(ROOT, `apps/app/e2e/${slug}.spec.ts`))) return true;
    const proof = getUiProofIndex().get(capName);
    return proof !== undefined && existsSync(join(ROOT, proof));
  }
  // The "api" layer has a fallback beyond filename existence: a combined
  // multi-capability route file (schema.ts, connection.ts, etc.) can satisfy
  // MANY capabilities without any of them having a dedicated file — see
  // apiLayerSatisfied above.
  if (layer === "api") {
    const hasDirectFile = stems.some((s) =>
      existsSync(join(ROOT, `apps/api/src/routes/v1/${s}.ts`)),
    );
    return apiLayerSatisfied({
      stems,
      capName,
      hasDirectFile,
      routeIndex: getApiRouteIndex(),
    });
  }
  // The "cli" layer reads the command files the way the api layer reads the
  // route files: a dedicated file, or the capability named inside a grouped
  // one. See cliLayerSatisfied above.
  if (layer === "cli") {
    const hasDirectFile = stems.some((s) =>
      existsSync(join(ROOT, `apps/cli/src/commands/${s}.ts`)),
    );
    return cliLayerSatisfied({
      stems,
      capName,
      capSurfaces,
      hasDirectFile,
      commandIndex: getCliCommandIndex(),
    });
  }
  const candidates = {
    // NOTE: `schema` and `marketing` are directory checks, not per-capability
    // ones, so they are effectively constants — `schema` is satisfied for every
    // capability (the schema dir always exists) and `marketing` for none
    // (apps/website is not one of this monorepo's apps). Neither proves anything
    // about the capability being checked; declaring them in a contract's
    // layers[] buys no real coverage.
    schema: [join(ROOT, "packages/database/src/schema")],
    unit: stems.map((s) => join(CAP_DIR, `${s}.test.ts`)),
    e2e: [join(ROOT, APP_DIR, "e2e", `${slug}.spec.ts`)],
    docs: stems.map((s) => join(ROOT, `docs/capabilities/${s}.md`)),
    marketing: [join(ROOT, "apps/website")],
  };
  const paths = candidates[layer] ?? [];
  return paths.some((p) => existsSync(p));
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
        f !== "index.ts" && // the contracts barrel/array, not a capability
        !f.endsWith(".test.ts") &&
        !f.endsWith(".handler.ts"),
    )
    .map((file) => {
      const src = readFileSync(join(CAP_DIR, file), "utf8");
      // Anchored to the start of a line so a prose mention inside a JSDoc
      // block cannot be read as a contract field. A comment line begins
      // with `*`, an object property does not. `check_ui_parity.mjs`
      // parses contracts the same way and must stay in step.
      // Anchored to the registerCapability(...) call, not only to a line start.
      // `^\\s*name:` stops the run.list.ts doc comment, whose line begins " * ",
      // but not an object literal elsewhere in the file whose own `name:` starts
      // a line — and a contract file is mostly schemas with defaults. These are
      // fields of that call, so the call is where they are read from.
      const declStart = src.search(/registerCapability\s*\(/);
      const decl = declStart === -1 ? "" : src.slice(declStart);
      const nameMatch = decl.match(/^\s*name:\s*["'`]([^"'`]+)["'`]/m);
      const domainMatch = decl.match(/^\s*domain:\s*["'`]([^"'`]+)["'`]/m);
      const modeMatch = decl.match(/^\s*mode:\s*["'`]([^"'`]+)["'`]/m);
      const layersMatch = decl.match(/^\s*layers:\s*\[([^\]]*)\]/m);
      const surfacesMatch = decl.match(/^\s*surfaces:\s*\[([^\]]*)\]/m);
      const name = nameMatch ? nameMatch[1] : file.replace(/\.ts$/, "");
      const domain = domainMatch ? domainMatch[1] : "unknown";
      const mode = modeMatch ? modeMatch[1] : "sync";
      const layers = layersMatch
        ? layersMatch[1]
            .split(",")
            .map((s) => s.trim().replace(/["'`]/g, ""))
            .filter(Boolean)
        : [];
      const surfaces = surfacesMatch
        ? surfacesMatch[1]
            .split(",")
            .map((s) => s.trim().replace(/["'`]/g, ""))
            .filter(Boolean)
        : ["api", "mcp"];
      // A file is only a CAPABILITY if it actually registers one. Shared schema
      // modules co-located in ./contracts (e.g. eval-schema.ts,
      // agent.memory_import.shared.ts) export zod fragments but never call
      // registerCapability — without this guard the `name:` regex falls back to
      // the filename stem and mints a phantom capability in the manifest.
      const hasRegister = /registerCapability\s*\(/.test(src);
      return { file, name, domain, mode, surfaces, layers, hasRegister };
    });
}

function main() {
  const allEntries = readCapabilities();
  // The barrel imports EVERY contract file (including shared schema modules) so
  // their exports resolve; only registering files count as capabilities.
  const caps = allEntries.filter((c) => c.hasRegister);

  // Genuine duplicate-name collision gate. The runtime registry is now resilient
  // to bundler/HMR re-registration (it keeps the first registration and warns
  // rather than crashing the dev server), so THIS build-time check is the
  // authoritative guard against two contract files claiming one capability name.
  // Hard-fail (exit 2) — an authoring collision is a broken repo, not an
  // incomplete feature.
  const filesByName = new Map();
  for (const cap of caps) {
    const arr = filesByName.get(cap.name) ?? [];
    arr.push(cap.file);
    filesByName.set(cap.name, arr);
  }
  const duplicates = [...filesByName.entries()].filter(
    ([, files]) => files.length > 1,
  );
  if (duplicates.length) {
    console.error(
      "DUPLICATE CAPABILITY NAMES — two contract files claim one name:",
    );
    for (const [name, files] of duplicates) {
      console.error(`  - "${name}": ${files.join(", ")}`);
    }
    process.exit(2);
  }

  // Auto-discovery: rewrite the contract barrel so adding a contract file is
  // the only step needed to register it.
  writeContractBarrel(allEntries.map((c) => c.file));
  info(`Wrote ${BARREL} with ${allEntries.length} contract imports.`);

  // No timestamp: this file is committed, so a `generatedAt` would make it
  // nondeterministic and churn git on every regeneration. The content is a
  // pure function of the contract files, which is what we want to track.
  const manifest = { capabilities: [] };
  // gapsByCap: { "<capability>": ["<missing layer>", ...] } — grouped so the
  // ticketer can open one item per capability rather than one per layer.
  const gapsByCap = {};

  for (const cap of caps) {
    const layerStatus = {};
    for (const layer of cap.layers) {
      const ok = layerSatisfied(
        layer,
        cap.name,
        cap.surfaces,
        cap.file.replace(/\.ts$/, ""),
      );
      layerStatus[layer] = ok;
      if (!ok) (gapsByCap[cap.name] ??= []).push(layer);
    }
    manifest.capabilities.push({
      name: cap.name,
      file: cap.file,
      domain: cap.domain,
      mode: cap.mode,
      surfaces: cap.surfaces,
      layers: layerStatus,
    });
  }

  const current = existsSync(MANIFEST) ? readFileSync(MANIFEST, "utf8") : "";
  if (manifestContentChanged(current, manifest)) {
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    info(
      `Wrote ${MANIFEST} with ${manifest.capabilities.length} capabilities.`,
    );
  } else {
    info(
      `${MANIFEST} is current (${manifest.capabilities.length} capabilities).`,
    );
  }

  const gaps = Object.entries(gapsByCap).map(([capability, missing]) => ({
    capability,
    missing,
  }));

  // --json: emit the structured gap list for ensure-manifest-tickets.ts.
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ gaps }, null, 2) + "\n");
    return;
  }

  if (gaps.length) {
    // GitHub Actions surfaces `::warning::` lines as annotations on the run.
    for (const { capability, missing } of gaps) {
      console.log(
        `::warning title=Manifest gap::${capability} missing layer(s): ${missing.join(", ")}`,
      );
    }
    console.error(
      "\nMANIFEST GAPS — feature incomplete (tracked in Linear, not blocking):",
    );
    for (const { capability, missing } of gaps) {
      for (const layer of missing)
        console.error(`  - ${capability}: missing "${layer}"`);
    }
    // --strict restores the hard gate; default is warn-only (exit 0).
    if (STRICT) {
      console.error("\n--strict: failing because gaps exist.");
      process.exit(1);
    }
    console.error(
      "\n(warn-only — pass --strict to fail; gaps are filed to Linear by ensure-manifest-tickets.)",
    );
    return;
  }
  info("All declared layers satisfied.");
}

// Only run when executed directly (not when imported by the test) — mirrors
// check_ui_parity.mjs so importing the pure exports above never has the side
// effect of rewriting the barrel/manifest during a test run.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
