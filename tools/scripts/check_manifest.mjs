#!/usr/bin/env node
/**
 * check_manifest.mjs — regenerate the capability manifest and verify every
 * declared layer has a file on disk. A red exit blocks the verification gate.
 *
 * Layer→path map matches this monorepo's layout (not the skill template's
 * placeholder Next.js single-app layout).
 */
import { readdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const CAP_DIR = join(ROOT, "packages/oxagen/src/contracts");
const MANIFEST = join(ROOT, "packages/oxagen/capabilities.manifest.json");

function slugify(name) {
  return name.replace(/\./g, "-");
}

function layerSatisfied(layer, capName) {
  const slug = slugify(capName);
  const candidates = {
    schema: [join(ROOT, "packages/database/src/schema")],
    api: [join(ROOT, `apps/api/src/routes/v1/${capName}.ts`)],
    mcp: [join(ROOT, `apps/mcp/src/tools/${capName}.ts`)],
    unit: [join(CAP_DIR, `${capName}.test.ts`)],
    e2e: [join(ROOT, `apps/app/e2e/${slug}.spec.ts`)],
    docs: [join(ROOT, `docs/capabilities/${capName}.md`)],
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
      return { file, name, domain, mode, surfaces, layers };
    });
}

function main() {
  const caps = readCapabilities();
  const manifest = { generatedAt: new Date().toISOString(), capabilities: [] };
  const gaps = [];

  for (const cap of caps) {
    const layerStatus = {};
    for (const layer of cap.layers) {
      const ok = layerSatisfied(layer, cap.name);
      layerStatus[layer] = ok;
      if (!ok) gaps.push(`${cap.name}: missing "${layer}"`);
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
  console.log(`Wrote ${MANIFEST} with ${manifest.capabilities.length} capabilities.`);

  if (gaps.length) {
    console.error("\nMANIFEST GAPS — feature incomplete:");
    for (const g of gaps) console.error(`  - ${g}`);
    process.exit(1);
  }
  console.log("All declared layers satisfied.");
}

main();
