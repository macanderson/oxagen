#!/usr/bin/env node
/**
 * Stage dist-standalone/ as the publishable @oxagen/recorder package: the three
 * bundled executables plus a manifest with no workspace dependencies.
 * Run order: scripts/bundle.mjs → this script → `npm publish dist-standalone`.
 *
 * The one runtime dependency is Cedar's evaluator. Its Node build reads its
 * `.wasm` from its own directory, so the bundles leave it out and npm
 * installs it beside them, at the version this package pins.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const distDir = resolve(root, "dist-standalone");

for (const name of ["tacho", "tachod", "tacho-hook"]) {
  if (!existsSync(resolve(distDir, `${name}.mjs`))) {
    throw new Error(
      `missing ${name}.mjs; run \`pnpm --filter @oxagen/recorder bundle\` first`,
    );
  }
}

const src = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const CEDAR = "@cedar-policy/cedar-wasm";
const cedarVersion = src.dependencies?.[CEDAR];
if (typeof cedarVersion !== "string" || cedarVersion.length === 0) {
  throw new Error(
    `package.json names no ${CEDAR} dependency, and the hook cannot decide Cedar policies without it`,
  );
}
const manifest = {
  name: src.name,
  version: src.version,
  description: src.description,
  type: "module",
  bin: {
    tacho: "./tacho.mjs",
    tachod: "./tachod.mjs",
    "tacho-hook": "./tacho-hook.mjs",
  },
  files: ["tacho.mjs", "tachod.mjs", "tacho-hook.mjs", "README.md"],
  dependencies: { [CEDAR]: cedarVersion },
  // zstd in `node:zlib`, which the daemon imports statically, arrived in Node
  // 22.15 and 23.8. On an older Node, `tachod` fails to link and records
  // nothing, so npm must refuse the install there (scripts/bundle.mjs).
  engines: { node: "^22.15.0 || >=23.8.0" },
  keywords: [
    "oxagen",
    "tacho",
    "claude-code",
    "agent",
    "governance",
    "telemetry",
  ],
  publishConfig: { access: "public" },
};
if (src.license) manifest.license = src.license;
writeFileSync(
  resolve(distDir, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
copyFileSync(resolve(root, "README.md"), resolve(distDir, "README.md"));
console.log(
  `✔ standalone manifest written to ${resolve(distDir, "package.json")}`,
);
console.log(
  `  install with:  npm i -g ${distDir}   (or npx @oxagen/recorder enroll once published)`,
);
