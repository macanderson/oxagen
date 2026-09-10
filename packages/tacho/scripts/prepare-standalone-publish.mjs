#!/usr/bin/env node
/**
 * Stage dist-standalone/ as the publishable @oxagen/tacho package: the three
 * bundled executables plus a manifest with no workspace dependencies.
 * Run order: scripts/bundle.mjs → this script → `npm publish dist-standalone`.
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
      `missing ${name}.mjs; run \`pnpm --filter @oxagen/tacho bundle\` first`,
    );
  }
}

const src = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
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
  engines: { node: ">=20" },
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
  `  install with:  npm i -g ${distDir}   (or npx @oxagen/tacho enroll once published)`,
);
