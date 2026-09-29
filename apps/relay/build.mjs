import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";

// Bundle the relay into one CommonJS file, dist/relay.cjs, which the
// container runs with plain Node.
//
// The @oxagen/* workspace packages export raw .ts, so Node cannot load them
// at runtime. esbuild inlines them and every npm dependency, and the image
// then needs no node_modules at all.
//
// A CommonJS bundle has no import.meta. A dependency that reads
// import.meta.url gets the bundle's own file URL from the banner below, and
// any other import.meta use fails the build, since it would read undefined
// when the relay runs. Nothing imports apps/relay, so this define cannot leak
// into the API or the MCP server.

const OUTFILE = "dist/relay.cjs";
const { version } = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));

const result = await build({
  entryPoints: ["src/main.ts"],
  outfile: OUTFILE,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // ws loads these native helpers only when they are installed, and falls
  // back to plain JavaScript when they are not.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: 'const __relay_import_meta_url = require("node:url").pathToFileURL(__filename).href;',
  },
  define: {
    "import.meta.url": "__relay_import_meta_url",
    __RELAY_VERSION__: JSON.stringify(version),
  },
  logLevel: "warning",
});

const importMeta = result.warnings.filter((warning) => warning.text.includes("import.meta"));
if (importMeta.length > 0) {
  console.error(`relay: the bundle reads import.meta in ${importMeta.length} place(s), which is undefined in CommonJS.`);
  process.exit(1);
}

// Boot the bundle with an empty environment. It must stop at the
// configuration check, exit 2, and name the first missing variable. A module
// that throws while it loads fails here instead of in a customer's cluster.
const smoke = spawnSync(process.execPath, [OUTFILE], { env: {}, encoding: "utf8", timeout: 20_000 });
if (smoke.status !== 2 || !smoke.stderr.includes("RELAY_BROKER_URL")) {
  console.error(`relay: the bundle did not stop at the configuration check (exit ${String(smoke.status)}).`);
  console.error(smoke.stderr);
  process.exit(1);
}

console.log(`relay: bundled ${OUTFILE} (version ${version})`);
