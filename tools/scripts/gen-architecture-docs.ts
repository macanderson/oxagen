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
 *   pnpm docs:architecture --check   # exit 1 when the committed output is stale
 *
 * Outputs:
 *   apps/docs/public/architecture/index.html         the atlas
 *   apps/docs/public/architecture/architecture.json  the model it was built from
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { argv, exit, stdout, stderr } from "node:process";
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
  const files: [string, string][] = [
    [join(outDir, "index.html"), result.html],
    [join(outDir, "architecture.json"), result.json],
  ];
  if (check) {
    const stale = files
      .filter(([p, content]) => readOrNull(p) !== content)
      .map(([p]) => p);
    if (stale.length) {
      stderr.write(
        `docs:architecture --check — stale output:\n  ${stale.join("\n  ")}\nRun \`pnpm docs:architecture\` and commit the result.\n`,
      );
      return 1;
    }
    stdout.write(
      `docs:architecture --check — up to date (${result.model.capabilities.length} capabilities, ${result.model.manifest.tables.length} tables, ${result.model.apiRoutes.length} routes).\n`,
    );
    return 0;
  }
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  for (const [p, content] of files) writeFileSync(p, content);
  const m = result.model;
  stdout.write(
    `docs:architecture — wrote ${outDir}\n` +
      `  ${m.packages.length} workspaces · ${m.manifest.tables.length} manifest tables · ${m.clickhouse.length} ClickHouse tables · ${m.capabilities.length} capabilities\n` +
      `  ${m.apiRoutes.length} API routes · ${m.mcpTools.length} MCP tools · ${m.inngest.length} Inngest functions · ${m.env.length} env vars · ${m.workflows.length} workflows · ${m.adrs.length} ADRs\n` +
      `  ${(result.html.length / 1024).toFixed(0)} KiB HTML\n`,
  );
  return 0;
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().then((code) => exit(code));
}
