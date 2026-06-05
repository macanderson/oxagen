#!/usr/bin/env node
/**
 * check_manifest.mjs — regenerate the capability manifest from the registry and
 * diff it against the filesystem to catch any layer a feature skipped.
 *
 * A capability declares the layers it must satisfy (in its registry entry).
 * This script verifies each required layer has a corresponding file, then writes
 * packages/oxagen/capabilities.manifest.json. Non-zero exit means a gap exists.
 *
 * Adjust ROOT and the layer path resolvers to match the actual repo layout.
 * This is intentionally dependency-light so it runs in CI and pre-commit alike.
 */
import { readdirSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const CAP_DIR = join(ROOT, "packages/oxagen/src/capabilities");
const MANIFEST = join(ROOT, "packages/oxagen/capabilities.manifest.json");

// Map a logical layer to the file(s) that prove it exists for a given capability.
// Returns true if at least one expected path is present.
function layerSatisfied(layer, capFile, capName) {
  const candidates = {
    schema: [join(ROOT, "packages/oxagen/src/db/schema")],
    api: [join(ROOT, `app/v1/${capName}/route.ts`)],
    mcp: [join(ROOT, `packages/mcp-server/src/tools/${capFile}`)],
    unit: [join(CAP_DIR, capFile.replace(/\.ts$/, ".test.ts"))],
    e2e: [join(ROOT, `e2e/${capFile.replace(/\.ts$/, ".spec.ts")}`)],
    docs: [join(ROOT, `docs/${capName}.md`), join(ROOT, `SPEC.md`)],
    marketing: [join(ROOT, "apps/marketing")], // presence-only; relevance is a human call
  };
  const paths = candidates[layer] ?? [];
  // schema/marketing are directory-level checks; others are file-level
  return paths.some((p) => existsSync(p));
}

function readCapabilities() {
  if (!existsSync(CAP_DIR)) {
    console.error(`No capabilities dir at ${CAP_DIR}. Is the repo layout different?`);
    process.exit(2);
  }
  return readdirSync(CAP_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((file) => {
      // Lightweight extraction: capability name + declared layers from source text.
      // In a real repo, import the compiled registry instead; this keeps the gate
      // runnable without a build step.
      const src = require("node:fs").readFileSync(join(CAP_DIR, file), "utf8");
      const nameMatch = src.match(/name:\s*["'`]([^"'`]+)["'`]/);
      const layersMatch = src.match(/layers:\s*\[([^\]]*)\]/);
      const name = nameMatch ? nameMatch[1] : file.replace(/\.ts$/, "");
      const layers = layersMatch
        ? layersMatch[1].split(",").map((s) => s.trim().replace(/["'`]/g, "")).filter(Boolean)
        : [];
      return { file, name, layers };
    });
}

function main() {
  const caps = readCapabilities();
  const manifest = { generatedAt: new Date().toISOString(), capabilities: [] };
  const gaps = [];

  for (const cap of caps) {
    const capSlug = cap.name.replace(/\./g, "-");
    const layerStatus = {};
    for (const layer of cap.layers) {
      const ok = layerSatisfied(layer, cap.file, capSlug);
      layerStatus[layer] = ok;
      if (!ok) gaps.push(`${cap.name}: missing "${layer}"`);
    }
    manifest.capabilities.push({ name: cap.name, file: cap.file, layers: layerStatus });
  }

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${MANIFEST} with ${manifest.capabilities.length} capabilities.`);

  if (gaps.length) {
    console.error("\nMANIFEST GAPS — feature incomplete:");
    for (const g of gaps) console.error(`  - ${g}`);
    process.exit(1);
  }
  console.log("All declared layers satisfied.");
}

main();
