#!/usr/bin/env node
/**
 * prepare-standalone-publish.mjs — turn the self-contained esbuild bundle into a
 * standalone-installable npm package staged under apps/cli/dist-standalone/.
 *
 * Why this exists
 * ---------------
 * Publishing apps/cli/package.json directly is BROKEN: its `dependencies` carry
 * unpublished `workspace:*` internal packages (and the workspace protocol
 * leaks into the manifest), and its `bin` points at dist/index.js whose
 * shebang is `#!/usr/bin/env tsx`. So `npm i -g @oxagen/cli` fails in any
 * clean environment.
 *
 * The fix: publish ONLY the single-file bundle produced by scripts/bundle.mjs
 * (dist-standalone/oxagen.mjs — every @oxagen/* and npm dep inlined, `node`
 * shebang) plus a clean manifest with NO workspace deps.
 *
 * Run order:  scripts/bundle.mjs  →  this script  →  `npm publish dist-standalone`
 * (the release pipeline in tools/scripts/release.ts wires all three together).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const distDir = resolve(cliRoot, "dist-standalone");
const bundle = resolve(distDir, "oxagen.mjs");

if (!existsSync(bundle)) {
  throw new Error(
    `Bundle missing at ${bundle}. Run \`pnpm --filter @oxagen/cli bundle\` first.`,
  );
}

const src = JSON.parse(readFileSync(resolve(cliRoot, "package.json"), "utf8"));

const manifest = {
  name: src.name,
  version: src.version,
  description: src.description,
  type: "module",
  bin: { oxagen: "./oxagen.mjs" },
  files: ["oxagen.mjs", "README.md"],
  engines: { node: ">=20" },
  keywords: src.keywords,
  homepage: src.homepage,
  repository: src.repository,
  publishConfig: { access: "public" },
};
if (src.license) manifest.license = src.license;

writeFileSync(
  resolve(distDir, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
copyFileSync(resolve(cliRoot, "README.md"), resolve(distDir, "README.md"));

console.log(
  `✔ standalone publish manifest written to ${resolve(distDir, "package.json")}`,
);
console.log(`  ${manifest.name}@${manifest.version}  (bin → ./oxagen.mjs)`);
console.log(`  publish with:  npm publish ${distDir}`);
