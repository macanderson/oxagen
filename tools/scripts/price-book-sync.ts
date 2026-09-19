#!/usr/bin/env tsx
/**
 * price-book-sync — write the list price book (`cost.price_entries`,
 * org_id NULL, source 'list') from every price source (ADR-060 §1): the
 * operator's environment overrides, the in-code rate cards in
 * `packages/billing/src/pricing.ts`, and the published catalogs.
 *
 *   pnpm billing:price-book-sync                         # report + DRY-RUN
 *   pnpm billing:price-book-sync --apply                 # write the rows
 *   pnpm billing:price-book-sync --offline               # skip the catalogs
 *   pnpm billing:price-book-sync --effective-from=<RFC 3339>
 *   pnpm billing:price-book-sync --resend-reprice        # re-ask for the reroll, no write
 *
 * **Nothing depends on anyone running this.** The `cost.price-book-sync` job
 * runs the same merge hourly, which is what keeps a fresh installation from
 * pricing nothing at all. This remains for a targeted correction, for
 * checking what the merge would write before it writes it, and for an
 * air-gapped installation where the catalogs are unreachable (`--offline`).
 *
 * A price is effective over [effective_from, effective_to). With no
 * `--effective-from` the run is effective from the instant it runs, so a
 * later run closes the previous rows at the new instant and every cost record
 * keeps the entry it was priced with. (The default used to be the top of the
 * UTC hour so a re-run within the hour corrected a row in place — but a row
 * whose instant has passed may already have priced runs, and `syncPriceBook`
 * now refuses to rewrite one; a same-instant re-run with unchanged terms is
 * still a no-op.) A run that would start earlier than an open row is refused
 * for the same reason: a correction is always a later row. Negotiated and
 * override rows are never touched.
 *
 * An `--apply` that backdated rows also requests the repricing, the same way
 * the hourly job does: the cold-start path writes a newly discovered key from
 * a floor instant before any frame, which prices runs that have already
 * sealed, and `cost.price-book-reprice` is what re-rolls them. Without that
 * request a manual apply left those totals blank for ever — the next hourly
 * sync found the book already correct and wrote nothing, so it asked for
 * nothing either.
 *
 * The hourly job cannot get stuck this way: its "write" and "send" are
 * separate Inngest steps, so a retry after a failed send replays from the
 * already-memoized write and only the send is retried. This script has no
 * such history — a plain re-run reads the book it just wrote as already
 * correct, so `written` comes back 0 and it would ask for nothing, leaving
 * the runs those backdated rows can now price blank for ever with no sign
 * anything is wrong. `--resend-reprice` is the direct recovery the
 * `RepriceRequestError` message below promises: it skips the sync and the
 * write entirely and only re-dispatches the event, so a failed dispatch is
 * recoverable without another `--apply` finding nothing left to do.
 *
 * Runs against whatever DATABASE_URL is in scope and prints the host so the
 * target is always visible (CLAUDE.md: echo the target DB before a mutation).
 */
import kleur from "kleur";
import {
  nextPriceBookBoundary,
  syncPriceBookFromSources,
  type PriceEntrySeed,
  type SyncPriceBookFromSourcesArgs,
} from "@oxagen/billing";
import { closeDatabase } from "@oxagen/database";
// The event name only, by relative path, as `inngest-verify.ts` reaches the
// same package: `@oxagen/inngest-functions` is not a dependency of the scripts
// workspace, and `src/events.ts` carries no dependencies of its own. The
// client that ships the event is loaded on demand in `sendBackdatedEvent`, so
// a dry run never constructs it.
import { PRICE_BOOK_BACKDATED_EVENT } from "../../packages/inngest-functions/src/events";

export interface Flags {
  apply: boolean;
  offline: boolean;
  effectiveFrom: Date;
  /**
   * Skip the sync and the write; only re-dispatch `PRICE_BOOK_BACKDATED_EVENT`.
   * The recovery path for a prior `--apply` whose write committed but whose
   * dispatch failed: a plain re-run of `--apply` finds the book already
   * correct (`written: 0`) and asks for nothing, so this is the only way to
   * resend without another write.
   */
  resendReprice: boolean;
}

export function parseFlags(argv: string[], now: Date): Flags {
  // The next hour boundary, the same instant the hourly job uses. `now` is
  // read before the catalogs and the transaction, so a frame rolled up in
  // between is priced against a row this run then closes behind it. An
  // operator who names an instant with --effective-from gets exactly that.
  const flags: Flags = {
    apply: false,
    offline: false,
    effectiveFrom: nextPriceBookBoundary(now),
    resendReprice: false,
  };
  for (const arg of argv) {
    if (arg === "--apply") flags.apply = true;
    else if (arg === "--offline") flags.offline = true;
    else if (arg === "--resend-reprice") flags.resendReprice = true;
    else if (arg.startsWith("--effective-from=")) {
      const at = new Date(arg.slice("--effective-from=".length));
      if (Number.isNaN(at.getTime()))
        throw new Error(`--effective-from must be an RFC 3339 instant: ${arg}`);
      // Never the past. A list row that starts at an instant already gone
      // reprices every frame settled since then on its next rollup, or makes
      // it unpriced, and `syncPriceBook` cannot catch it for a key with no
      // open row (one newly seen, or retired). Backdating is the cold-start
      // path's job alone, and it does it under its own rules.
      if (at.getTime() < now.getTime())
        throw new Error(
          `--effective-from must not be in the past (${at.toISOString()} is before ${now.toISOString()}): a list price that starts in the past reprices runs already settled`,
        );
      flags.effectiveFrom = at;
    } else throw new Error(`unknown flag: ${arg}`);
  }
  return flags;
}

/** One line per seed row: what the sync will write. */
export function reportLines(seeds: readonly PriceEntrySeed[]): string[] {
  return seeds.map(
    (s) =>
      `${s.provider.padEnd(12)} ${s.model.padEnd(40)} ${s.tokenClass.padEnd(16)} ${s.microsPerMillion.toString().padStart(14)} micros/1M ${s.unit}`,
  );
}

/** The database host a DATABASE_URL points at, with no credentials. */
export function describeTarget(databaseUrl: string | undefined): string {
  if (!databaseUrl) return "(DATABASE_URL unset)";
  try {
    const url = new URL(databaseUrl);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(DATABASE_URL unparseable)";
  }
}

/** The shape `sendBackdatedEvent` and the injected test double both take. */
export type EventSender = (event: {
  name: string;
  data: Record<string, never>;
}) => Promise<void>;

/**
 * A manual apply wrote the book but the repricing it made possible could not
 * be requested. Typed with a stable `code` so the exit path can say which of
 * the two halves failed: the prices are in force, the runs they can now price
 * are still blank.
 */
export class RepriceRequestError extends Error {
  readonly code = "price_book_reprice_request_failed" as const;
  constructor(cause: unknown) {
    super(
      `the price book was written but the repricing request could not be dispatched: ${cause instanceof Error ? cause.message : String(cause)}. The backdated prices are in force; runs sealed before them keep a blank or estimated cost until ${PRICE_BOOK_BACKDATED_EVENT} is delivered — check the event key and the Inngest endpoint, then re-run with --resend-reprice (a plain --apply re-run finds the book already correct and requests nothing).`,
      { cause },
    );
    this.name = "RepriceRequestError";
  }
}

/**
 * Whether this run has to ask for the runs it can now price to be re-rolled.
 *
 * The same test the hourly job makes, for the same reason: only a backdated
 * write prices something that has already run. A row effective from a future
 * instant prices nothing settled, an unchanged book writes nothing at all,
 * and a dry run wrote nothing to reprice against.
 */
export function needsReprice(args: {
  apply: boolean;
  coldStart: boolean;
  written: number;
}): boolean {
  return args.apply && args.coldStart && args.written > 0;
}

/**
 * Ship the event through the same seam every other sender uses. Imported here
 * rather than at module scope so the report and the dry run never construct an
 * Inngest client, and so a test can pass its own sender.
 */
export const sendBackdatedEvent: EventSender = async (event) => {
  const { createEventClient } = await import(
    "../../packages/inngest-functions/src/adapter"
  );
  await createEventClient().send(event);
};

export interface RunDeps {
  /** Ships the repricing request. */
  send: EventSender;
  /** Where the report goes. */
  log: (line: string) => void;
  /** The price-book writer; the real transaction unless a test injects one. */
  write?: SyncPriceBookFromSourcesArgs["write"];
}

/**
 * Merge the sources, report, and on `--apply` write the book — then, if the
 * write backdated rows, request the repricing.
 *
 * The request is the whole reason this is not just a print. Before it existed
 * a manual apply against a cold or partly-filled book backdated rows and
 * stopped there: `cost.run-rollup` had already written `run_totals` rows with
 * a blank or `estimated` cost, the nightly sweep skips them because their
 * `rolled_up_at` is after their seal, and the next hourly sync found the book
 * already correct, wrote nothing, and so requested nothing either. Those runs
 * read "not recorded" for ever, and the operator who ran the sync to fix the
 * prices had no way to know. The event is the hourly job's own chain —
 * `cost.price-book-reprice` pages through every incomplete run behind a
 * keyset cursor — so this dispatches it rather than walking runs itself.
 *
 * `--resend-reprice` skips the sync and the write entirely and only
 * re-dispatches the event: the recovery path for a write that committed but
 * whose dispatch failed, since a plain `--apply` re-run reads that same book
 * back as already correct (`written: 0`) and asks for nothing.
 */
export async function runPriceBookSync(
  flags: Flags,
  deps: RunDeps,
): Promise<void> {
  const { log } = deps;
  log(kleur.bold().cyan("\n══ Price book ══\n"));
  log(`  Target database: ${describeTarget(process.env["DATABASE_URL"])}`);

  if (flags.resendReprice) {
    log(
      kleur.dim(
        "  --resend-reprice: skipping the sync and the write, re-dispatching the reprice request only.\n",
      ),
    );
    try {
      await deps.send({ name: PRICE_BOOK_BACKDATED_EVENT, data: {} });
    } catch (err) {
      console.error(
        kleur.red("  ! requesting the repricing failed:"),
        err,
        `\n    event: ${PRICE_BOOK_BACKDATED_EVENT}`,
      );
      throw new RepriceRequestError(err);
    }
    log(
      kleur.bold().cyan("  Requested ") +
        `${PRICE_BOOK_BACKDATED_EVENT}: every run whose cost is blank or estimated and which the current book can now price will be re-rolled.\n`,
    );
    return;
  }

  log(`  Effective from:  ${flags.effectiveFrom.toISOString()}`);
  log(
    `  Catalogs:        ${flags.offline ? "skipped (--offline)" : "OpenRouter, models.dev"}\n`,
  );

  const report = await syncPriceBookFromSources({
    effectiveFrom: flags.effectiveFrom,
    offline: flags.offline,
    dryRun: !flags.apply,
    ...(deps.write ? { write: deps.write } : {}),
  });

  for (const [source, count] of Object.entries(report.counts))
    if (count > 0) log(`  ${source.padEnd(18)} ${count} models`);
  log(`\n  ${report.models} models priced in total.`);

  for (const failure of report.failures)
    log(
      kleur.yellow(
        `  ! ${failure.source} contributed nothing: ${failure.error}`,
      ),
    );
  for (const source of report.held)
    log(
      kleur.yellow(
        `  ! ${source} answered but was held: a catalog above it failed, and its prices must not supersede rows that catalog still has in force`,
      ),
    );

  if (!flags.apply) {
    log(kleur.dim("\n  Rows this would write:\n"));
    for (const line of reportLines(report.seeds)) log(`  ${line}`);
    log(
      kleur.dim(
        `\n  ${report.seeds.length} rows (dry-run — pass --apply to write.)\n`,
      ),
    );
    return;
  }

  log(
    kleur.bold().cyan("\n══ Done ══\n") +
      `  ${report.written} rows written, ${report.renamed} renamed, ${report.superseded} superseded, ${report.retired} retired, ${report.unchanged} unchanged, ${report.deferred} deferred to a scheduled correction.\n`,
  );

  if (
    !needsReprice({
      apply: flags.apply,
      coldStart: report.coldStart,
      written: report.written,
    })
  )
    return;

  try {
    await deps.send({ name: PRICE_BOOK_BACKDATED_EVENT, data: {} });
  } catch (err) {
    // Log the cause with its context, then rethrow it typed: the exit path
    // must fail, because a run that backdated prices and did not ask for the
    // repricing looks exactly like a success and leaves the costs blank.
    console.error(
      kleur.red("  ! requesting the repricing failed:"),
      err,
      `\n    event: ${PRICE_BOOK_BACKDATED_EVENT}`,
    );
    throw new RepriceRequestError(err);
  }
  log(
    kleur.bold().cyan("  Backdated rows written. ") +
      `Requested ${PRICE_BOOK_BACKDATED_EVENT}: every run whose cost is blank or estimated and which these prices can now price will be re-rolled.\n`,
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2), new Date());
  await runPriceBookSync(flags, {
    send: sendBackdatedEvent,
    log: (line) => console.log(line),
  });
}

// Run only when invoked directly, so a test can import the pure helpers
// without the module writing the price book as a side effect.
const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
  main()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error(kleur.red("price-book-sync failed:"), err);
      await closeDatabase();
      process.exit(1);
    });
}
