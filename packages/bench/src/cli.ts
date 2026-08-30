#!/usr/bin/env tsx
/**
 * Internal-only entry point for the bench list/replay commands — never part
 * of the distributed `oxagen` CLI (apps/cli). Deliberately minimal argv
 * parsing rather than pulling in commander/ink: this is a two-subcommand
 * tool for Oxagen's own benchmark tracking, not a product surface.
 *
 * Usage (see package.json scripts):
 *   pnpm --filter @oxagen/bench list [-- --type <bench_type>] [-- -n <limit>] [-- --json]
 *   pnpm --filter @oxagen/bench replay -- <public_id> [--run] [--json]
 */
import { closeClickhouse, isDirectRunEntry } from "@oxagen/telemetry";
import { handleBenchList, handleBenchReplay } from "./commands";

export function parseFlags(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg === "-n") {
      flags.limit = argv[++i] ?? "";
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const [subcommand, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);

  if (subcommand === "list") {
    await handleBenchList({
      type: typeof flags.type === "string" ? flags.type : undefined,
      limit: typeof flags.limit === "string" ? flags.limit : undefined,
      json: flags.json === true,
    });
    return;
  }

  if (subcommand === "replay") {
    await handleBenchReplay(positional[0], {
      run: flags.run === true,
      json: flags.json === true,
    });
    return;
  }

  process.stderr.write(
    "Usage: pnpm --filter @oxagen/bench <list|replay> ...\n",
  );
  process.exitCode = 1;
}

// Only auto-run when invoked directly (tsx src/cli.ts ...), not when imported
// by a test — same guard telemetry's migrate.ts uses.
// Bundle-safe direct-run guard — see @oxagen/telemetry is-direct-run.ts.
if (isDirectRunEntry(import.meta.url, process.argv[1], "cli")) {
  main()
    .then(() => closeClickhouse())
    .catch(async (err: unknown) => {
      process.stderr.write(
        `bench cli failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await closeClickhouse();
      process.exitCode = 1;
    });
}
