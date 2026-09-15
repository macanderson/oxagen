/**
 * gen-architecture-docs.ts — build the Oxagen Architecture Atlas.
 *
 * A self-contained HTML page of architecture diagrams generated from the
 * tree: the workspace graph, the storage manifest (Postgres ERDs, ClickHouse,
 * Neo4j, Blob), capability contracts and their handler bindings, API routes
 * and auth tiers, Inngest event graph, environment contract, CI workflows,
 * ADRs, plus curated mechanism flows whose source references are verified.
 *
 *   pnpm docs:architecture           # write apps/docs/public/architecture/
 *   pnpm docs:architecture --check   # build in memory: refs resolve, output is
 *                                    # byte-identical across two builds
 *
 * The output is NOT committed. `apps/docs` runs this as its `prebuild` and
 * `predev`, so the docs site always carries the atlas of the tree it was built
 * from, and no PR has to regenerate a megabyte of HTML to stay green. What CI
 * guards instead (`--check`, in the gate) is the part that can rot silently:
 * every curated flow's cited file and symbol must still exist, and the build
 * must be deterministic.
 *
 * Outputs:
 *   apps/docs/public/architecture/index.html         the atlas
 *   apps/docs/public/architecture/architecture.json  the model it was built from
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectModel, type Model } from "./lib/archdocs/collect";
import { verifyRefs } from "./lib/archdocs/flows";
import { renderSite, toDocument } from "./lib/archdocs/site";

export const ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const OUT_DIR = "apps/docs/public/architecture";

/** Sorted-key JSON so the model file is byte-stable across runs. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  return `${JSON.stringify(sort(value), null, 1)}\n`;
}

export function readOrNull(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export interface BuildResult {
  html: string;
  json: string;
  model: Model;
}

export async function build(root: string): Promise<BuildResult> {
  const problems = verifyRefs(root, readOrNull);
  if (problems.length) {
    throw new Error(
      `curated flows cite sources that no longer exist:\n  ${problems.join("\n  ")}\nUpdate tools/scripts/lib/archdocs/flows.ts to match the tree.`,
    );
  }
  const model = await collectModel(root);
  const { root: _root, ...rest } = model;
  const html = toDocument(renderSite(model));
  return { html, json: canonicalJson(rest), model };
}

function summary(m: Model): string {
  return (
    `  ${m.packages.length} workspaces · ${m.manifest.tables.length} manifest tables · ${m.clickhouse.length} ClickHouse tables · ${m.capabilities.length} capabilities\n` +
    `  ${m.apiRoutes.length} API routes · ${m.mcpTools.length} MCP tools · ${m.inngest.length} Inngest functions · ${m.env.length} env vars · ${m.workflows.length} workflows · ${m.adrs.length} ADRs\n`
  );
}

export async function main(args: string[] = argv.slice(2)): Promise<number> {
  const check = args.includes("--check");
  const outIdx = args.indexOf("--out");
  const outDir =
    outIdx >= 0 && args[outIdx + 1]
      ? resolve(args[outIdx + 1]!)
      : join(ROOT, OUT_DIR);
  let result: BuildResult;
  try {
    result = await build(ROOT);
  } catch (err) {
    stderr.write(
      `docs:architecture — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  if (check) {
    // A second build proves the page is a pure function of the tree: no
    // clock, no randomness, no map-iteration-order accidents.
    const again = await build(ROOT);
    if (again.html !== result.html || again.json !== result.json) {
      stderr.write(
        "docs:architecture --check — two builds of the same tree differ; the generator is not deterministic.\n",
      );
      return 1;
    }
    stdout.write(
      `docs:architecture --check — refs resolve, output deterministic.\n${summary(result.model)}`,
    );
    return 0;
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), result.html);
  writeFileSync(join(outDir, "architecture.json"), result.json);
  stdout.write(
    `docs:architecture — wrote ${outDir}\n${summary(result.model)}  ${(result.html.length / 1024).toFixed(0)} KiB HTML\n`,
  );
  return 0;
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().then((code) => exit(code));
}
