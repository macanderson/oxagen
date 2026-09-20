import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, "packages/database/dist/platform-seed");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "src"), { recursive: true });
await build({
  entryPoints: [join(root, "tools/scripts/seed-platform.ts")],
  outfile: join(output, "src/platform-seed.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  external: [
    "pg-native",
    "better-sqlite3",
    "aws-sdk",
    "nock",
    "mock-aws-s3",
    "@mapbox/node-pre-gyp",
    "duckdb",
  ],
});
// seed-book-editions resolves assets one directory above its module. The
// bundle preserves that layout without needing the workspace on the node.
await cp(
  join(root, "packages/database/seed-assets"),
  join(output, "seed-assets"),
  { recursive: true },
);
console.log(
  `Packaged platform seed in ${dirname(join(output, "src/platform-seed.mjs"))}`,
);
