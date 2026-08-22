/**
 * eval-ingest — load normalized `*.eval.json` files into the ClickHouse eval tables.
 *
 *   pnpm eval:ingest tools/eval-out/engram-golden.eval.json
 *   pnpm eval:ingest --force results/run.eval.json    # re-ingest (skips the dup guard)
 *
 * This is how an out-of-process harness lands its results in ClickHouse: it writes a
 * normalized `.eval.json`, then this loads it. If CLICKHOUSE_* env is absent it prints
 * a notice and exits 0 (so local/offline runs don't fail).
 */
import { closeClickhouse } from "@oxagen/telemetry";
import {
  ingestRun,
  loadEvalFile,
  clickhouseConfigured,
  type EvalRunFile,
} from "./lib/eval-protocol";

function parseArgs(argv: string[]): {
  paths: string[];
  force: boolean;
  agentVersion?: string;
} {
  const paths: string[] = [];
  let force = false;
  let agentVersion: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--force") force = true;
    else if (a === "--agent-version") agentVersion = argv[++i];
    else paths.push(a);
  }
  return { paths, force, agentVersion };
}

/** Ingest an array of already-loaded run files; returns a one-line summary per run. */
export async function ingestFiles(
  files: EvalRunFile[],
  opts: { force?: boolean; agentVersion?: string } = {},
): Promise<string[]> {
  const lines: string[] = [];
  for (const file of files) {
    if (opts.agentVersion && !file.run.agent_version)
      file.run.agent_version = opts.agentVersion;
    const r = await ingestRun(file, { force: opts.force });
    lines.push(
      `  ${r.status.padEnd(22)} ${file.run.harness}/${file.run.suite} ${r.run_id} (${r.results} results)`,
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const { paths, force, agentVersion } = parseArgs(process.argv.slice(2));
  if (paths.length === 0) {
    process.stderr.write(
      "usage: eval:ingest <file.eval.json...> [--force] [--agent-version X]\n",
    );
    process.exitCode = 1;
    return;
  }
  if (!clickhouseConfigured()) {
    process.stdout.write(
      "ClickHouse not configured (CLICKHOUSE_URL/CLICKHOUSE_DATABASE unset) — skipping ingest.\n" +
        "Run with a synced .env.local (pnpm env:pull) to land results in ClickHouse.\n",
    );
    return;
  }
  const files = paths.flatMap((p) => {
    try {
      return loadEvalFile(p);
    } catch (err) {
      process.stderr.write(
        `  skipped ${p}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return [];
    }
  });
  if (files.length === 0) {
    process.stdout.write("No valid eval files to ingest.\n");
    return;
  }
  const lines = await ingestFiles(files, { force, agentVersion });
  process.stdout.write(
    `Ingested ${files.length} run(s) into ClickHouse:\n${lines.join("\n")}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")
) {
  main()
    .then(() => closeClickhouse())
    .catch(async (err: unknown) => {
      process.stderr.write(
        `eval-ingest failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await closeClickhouse();
      process.exitCode = 1;
    });
}
