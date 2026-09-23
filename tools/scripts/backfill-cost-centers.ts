#!/usr/bin/env tsx
/**
 * backfill-cost-centers — charge the runs that predate a cost-center label
 * (ADR-142).
 *
 *   pnpm db:backfill-cost-centers                    # list and report, DRY RUN
 *   pnpm db:backfill-cost-centers --apply            # request the rebuilds
 *   pnpm db:backfill-cost-centers --org <uuid>       # one organization
 *   pnpm db:backfill-cost-centers --limit 200        # stop after 200 runs
 *
 * A `cost.run_totals` row records the cost center the rollup resolved when it
 * rolled the run up. A row written before the column existed, or before its
 * agent or workspace was charged to a label, holds null and reads as
 * unassigned on Spend and on the chargeback statement. The seal-time rollup
 * and the nightly sweep never revisit such a row, because its `rolled_up_at`
 * postdates its seal.
 *
 * This lists those rows through `listRunsWithUnassignedCostCenter`, which
 * keeps a row only when its agent's label, or failing that its workspace's,
 * is live on the organization's list now. With `--apply` it sends one
 * `cost/run.sealed` per run, the event the tacho ingest handler sends at a
 * seal. `cost.run-rollup` then rebuilds the run row from its frames where
 * every store is in reach, rebuilds the workspace-day's daily totals, and
 * asks for a findings pass, exactly as it does for a fresh seal. The script
 * itself writes nothing.
 *
 * Only rows with a null cost center are listed. Moving a run from one label
 * to another is a policy ADR-142 has not decided, and a pass that did it
 * silently would rewrite a closed month's statement.
 *
 * Safety:
 *   - Dry run by default; `--apply` sends.
 *   - Prints the target host and database first, and asks before sending
 *     against a host that is not local.
 *   - Idempotent: a run the rebuild charged is not listed again, and a run
 *     it could not charge is listed on the next pass.
 *   - A page whose send fails is counted and the pass goes on; rerun to
 *     pick those runs up.
 *
 * Env:
 *   DATABASE_URL for the list. The event client reads the Inngest
 *   environment the app uses (`INNGEST_EVENT_KEY` and its companions), and
 *   is constructed only on `--apply`. `tsx --env-file` does not override a
 *   shell-set DATABASE_URL; unset it to target the env file's database.
 */

import { createInterface } from "node:readline";
import { URL } from "node:url";
import kleur from "kleur";
import { listRunsWithUnassignedCostCenter } from "@oxagen/billing";
import { requireEnv } from "@oxagen/config/env";
import { closeDatabase } from "@oxagen/database";
import { formatError } from "./lib/format-error";
import {
  backfillCostCenters,
  type BackfillArgs,
  type RunSealedEvent,
} from "./lib/backfill-cost-centers";

export type Flags = BackfillArgs;

const DEFAULT_PAGE = 100;
const DEFAULT_LIMIT = 10_000;

/** Reads the flags; a bad value is refused with its name rather than defaulted. */
export function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    apply: false,
    pageSize: DEFAULT_PAGE,
    maxRuns: DEFAULT_LIMIT,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [name, inline] = arg.split("=", 2);
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      const next = argv[i];
      if (next === undefined) throw new Error(`${name} needs a value`);
      return next;
    };
    switch (name) {
      case "--apply":
        flags.apply = true;
        break;
      case "--org": {
        const org = value();
        if (!/^[0-9a-f-]{36}$/i.test(org))
          throw new Error(`--org takes an organization uuid, got ${org}`);
        flags.orgId = org;
        break;
      }
      case "--limit": {
        const n = Number(value());
        if (!Number.isInteger(n) || n <= 0)
          throw new Error(`--limit takes a positive integer`);
        flags.maxRuns = n;
        break;
      }
      case "--page": {
        const n = Number(value());
        if (!Number.isInteger(n) || n <= 0)
          throw new Error(`--page takes a positive integer`);
        flags.pageSize = n;
        break;
      }
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  return flags;
}

function sanitizeUrl(raw: string): { host: string; database: string } {
  try {
    const u = new URL(raw);
    return {
      host: `${u.hostname}:${u.port || "5432"}`,
      database: u.pathname.replace(/^\//, "") || "(default)",
    };
  } catch {
    return { host: "(unparseable)", database: "(unparseable)" };
  }
}

function isLocalHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|::1)(:\d+)?$/.test(host);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

/** The event client, loaded only when a send is about to happen. */
async function sendEvents(events: RunSealedEvent[]): Promise<void> {
  const { createEventClient } = await import(
    "../../packages/inngest-functions/src/adapter"
  );
  await createEventClient().send(events);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const env = requireEnv(["DATABASE_URL"]);
  const { host, database } = sanitizeUrl(env.DATABASE_URL);

  console.log(kleur.cyan("backfill-cost-centers (ADR-142)"));
  console.log(`  Target host  : ${kleur.yellow(host)}`);
  console.log(`  Database     : ${kleur.yellow(database)}`);
  console.log(
    `  Organization : ${flags.orgId ? kleur.yellow(flags.orgId) : kleur.dim("every organization")}`,
  );
  console.log(
    `  Mode         : ${flags.apply ? kleur.red("APPLY (sends rebuild requests)") : kleur.blue("DRY RUN (lists only)")}`,
  );
  console.log(`  Run cap      : ${flags.maxRuns}, ${flags.pageSize} per page`);
  console.log();

  if (flags.apply && !isLocalHost(host)) {
    const ok = await confirm(
      "  Send rebuild requests for a non-local database? [y/N] ",
    );
    if (!ok) {
      console.log(kleur.yellow("  Aborted."));
      process.exit(0);
    }
    console.log();
  }

  const report = await backfillCostCenters(flags, {
    list: listRunsWithUnassignedCostCenter,
    send: sendEvents,
    log: (line) => console.log(`  ${line}`),
  });

  console.log();
  console.log(kleur.cyan("Summary"));
  console.log(`  Runs a live label claims : ${report.listed}`);
  console.log(
    `  Rebuilds requested       : ${flags.apply ? kleur.green(String(report.requested)) : kleur.dim("0 (dry run)")}`,
  );
  console.log(
    `  Pages that failed to send: ${report.failedPages > 0 ? kleur.red(String(report.failedPages)) : kleur.dim("0")}`,
  );
  if (report.truncated) {
    console.log(
      kleur.yellow(
        `  More runs remain past the cap of ${flags.maxRuns}. Rerun to continue.`,
      ),
    );
  }
  if (!flags.apply && report.listed > 0) {
    console.log();
    console.log(
      kleur.blue("  Dry run. Rerun with --apply to request the rebuilds."),
    );
  }

  await closeDatabase();
  if (report.failedPages > 0) process.exit(1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(
      kleur.red(`backfill-cost-centers failed: ${formatError(err)}`),
    );
    process.exit(1);
  });
}
