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
 * file, return the set of contract stems any of them import plus the
 * concatenated source (for a literal-name fallback scan). No filesystem
 * access, so it's directly unit-testable.
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
  return { importedStems, content };
}

/**
 * Pure evidence check for the "api" layer. Primary evidence (a dedicated
 * per-capability route file) is resolved by the caller via `hasDirectFile` so
 * this function needs no disk access to test. Fallback evidence (dispatched
 * from a combined multi-capability route file) is either of:
 *   - the capability's contract module is imported by some route file
 *     (`from ".../contracts/<stem>"`, matched against either candidate stem)
 *   - the route source contains the capability's exact registered name as a
 *     quoted string literal (covers dispatch sites where the imported
 *     identifier doesn't textually match either stem)
 *
 * @param {{stems: string[], capName: string, hasDirectFile: boolean, routeIndex: {importedStems: Set<string>, content: string}}} args
 */
export function apiLayerSatisfied({
  stems,
  capName,
  hasDirectFile,
  routeIndex,
}) {
  if (hasDirectFile) return true;
  if (stems.some((s) => routeIndex.importedStems.has(s))) return true;
  return (
    routeIndex.content.includes(`"${capName}"`) ||
    routeIndex.content.includes(`'${capName}'`) ||
    routeIndex.content.includes(`\`${capName}\``)
  );
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
 * repo.ts, semantic-edge.ts, workflow.ts, plugin-schema.ts, reseller.ts) —
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
  const candidates = {
    // NOTE: `schema` and `marketing` are directory checks, not per-capability
    // ones, so they are effectively constants — `schema` is satisfied for every
    // capability (the schema dir always exists) and `marketing` for none
    // (apps/website is not one of this monorepo's apps). Neither proves anything
    // about the capability being checked; declaring them in a contract's
    // layers[] buys no real coverage.
    schema: [join(ROOT, "packages/database/src/schema")],
    unit: stems.map((s) => join(CAP_DIR, `${s}.test.ts`)),
    e2e: [join(ROOT, `apps/app/e2e/${slug}.spec.ts`)],
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
      const nameMatch = src.match(/name:\s*["'`]([^"'`]+)["'`]/);
      const domainMatch = src.match(/domain:\s*["'`]([^"'`]+)["'`]/);
      const modeMatch = src.match(/mode:\s*["'`]([^"'`]+)["'`]/);
      const layersMatch = src.match(/layers:\s*\[([^\]]*)\]/);
      const surfacesMatch = src.match(/surfaces:\s*\[([^\]]*)\]/);
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

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  info(`Wrote ${MANIFEST} with ${manifest.capabilities.length} capabilities.`);

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
