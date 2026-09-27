import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { requireEnv } from "@oxagen/config/env";
import { clickhouse, closeClickhouse } from "./clickhouse";
import { withMigrationLock } from "./migration-lock";
import { isDirectRunEntry } from "./is-direct-run";
import {
  clickhouseRebuildStore,
  parseRebuildDirective,
  REBUILD_CLIENT_OPTIONS,
  rebuildPartitionKey,
} from "./table-rebuild";

/** Sleep helper for the cold-start retry loop. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create the target database if it doesn't exist. The local docker ClickHouse
 * auto-creates it from CLICKHOUSE_DB, but ClickHouse Cloud does not — and a
 * connection scoped to a database that doesn't exist yet is rejected, so the
 * `CREATE DATABASE` must run through a bootstrap client with no database bound.
 *
 * ClickHouse Cloud auto-pauses idle services; the first connection wakes the
 * service, which can take longer than the default 30s request timeout. So this
 * is the first CH contact of the migrate run: use a longer per-attempt timeout
 * and retry on transient connection/timeout errors so a cold-start wake-up
 * doesn't fail the deploy. A genuinely-unreachable service still fails after
 * the retries (surfacing the real problem rather than hiding it).
 */
async function ensureDatabase(): Promise<void> {
  const env = requireEnv([
    "CLICKHOUSE_URL",
    "CLICKHOUSE_USERNAME",
    "CLICKHOUSE_PASSWORD",
    "CLICKHOUSE_DATABASE",
  ] as const);
  const bootstrap = createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USERNAME,
    password: env.CLICKHOUSE_PASSWORD,
    request_timeout: 60_000,
  });
  const attempts = 5;
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await bootstrap.command({
          query: `CREATE DATABASE IF NOT EXISTS \`${env.CLICKHOUSE_DATABASE}\``,
        });
        return;
      } catch (err) {
        if (attempt === attempts) throw err;
        process.stderr.write(
          JSON.stringify({
            level: "warn",
            msg: `ClickHouse not ready (attempt ${attempt}/${attempts}) — likely a Cloud cold-start; retrying`,
            err: err instanceof Error ? err.message : String(err),
          }) + "\n",
        );
        await delay(15_000);
      }
    }
  } finally {
    await bootstrap.close();
  }
}

/**
 * The connection a `REBUILD TABLE` directive runs on (#4297).
 *
 * The shared client gives up on a request after 30 seconds, and a copy of a
 * large partition can take longer. The server keeps running a write the client
 * gave up on, so the migration would fail while the copy carried on unseen.
 * `REBUILD_CLIENT_OPTIONS` holds the wait, the progress headers that keep the
 * SSM tunnel busy, and room for them. This client skips the shared client's
 * circuit breaker, as the bootstrap client above does: a migration should
 * fail on the error itself.
 */
function rebuildClient(): ClickHouseClient {
  const env = requireEnv([
    "CLICKHOUSE_URL",
    "CLICKHOUSE_USERNAME",
    "CLICKHOUSE_PASSWORD",
    "CLICKHOUSE_DATABASE",
  ] as const);
  return createClient({
    ...REBUILD_CLIENT_OPTIONS,
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USERNAME,
    password: env.CLICKHOUSE_PASSWORD,
    database: env.CLICKHOUSE_DATABASE,
  });
}

export function splitStatements(sql: string): string[] {
  // Strip leading comment lines per chunk so a statement preceded by
  // commentary still executes.
  return sql
    .split(/;\s*$/m)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

// ── Applied-migrations ledger (#2632) ─────────────────────────────────────────
//
// `_migrations` matches the name this very monorepo's Postgres runner used for
// the identical job before it was replaced by Atlas — see
// packages/database/atlas.hcl's `exclude = ["atlas_schema_revisions",
// "_migrations"]` and packages/database/drizzle/README.md. ClickHouse's runner
// never grew the equivalent table; this gives it the one this repo already
// had a name for, rather than inventing a new one.
const LEDGER_TABLE = "_migrations";

/**
 * The last `migrations/*.sql` filename that exists as of the PR introducing
 * this ledger (#2632), in the same lexicographic order `migrate()` applies
 * them. Every environment that has ever run `migrate()` before this change
 * has already applied every file up to and including this one — repeatedly,
 * on every deploy, under the old replay-everything semantics — so the
 * bootstrap in `migrate()` below marks exactly this file and everything
 * before it as already applied, WITHOUT re-executing them, on the run that
 * `decideLedgerAction` classifies as `bootstrap`. That one skip is what stops
 * the deploy shipping this fix from performing 0021's `DROP TABLE` one more
 * time — the last occurrence of the exact data loss this ledger exists to end.
 *
 * What makes a run a `bootstrap` is the ledger's recorded origin, not the
 * shape of the database at the time. An earlier version keyed it on "an empty
 * ledger in a database that already has other tables", a state two different
 * histories produce and which wants opposite treatment in each — see
 * LEDGER_ORIGIN_PRE_LEDGER.
 *
 * Do NOT bump this constant when adding a new migration file. It is a
 * one-time cutover marker for the pre-ledger backlog, not a "latest
 * migration" pointer: a filename that sorts AFTER it is — by construction —
 * one this constant's author never saw, so it is never swept into the
 * baseline and always executes for real, INCLUDING against an existing
 * deployment, even one upgrading to this ledger in the same deploy that adds
 * the new file.
 */
const PRE_LEDGER_BASELINE_CUTOVER = "0026_stella_operational_events.sql";

/**
 * The origin of a `_migrations` table, written into the table's own COMMENT by
 * the CREATE that makes it.
 *
 * WHY THIS IS IN THE TABLE DEFINITION AND NOT IN A ROW
 *   The question the baseline bootstrap turns on — did this database exist
 *   before the ledger? — is answerable ONLY in the instant before
 *   `_migrations` is created. Creating the table destroys the evidence: from
 *   then on, "has tables, has an empty ledger" is produced by two histories
 *   that want opposite treatment, and no later inspection can tell them apart.
 *
 *     a fresh database whose first ledger-aware run created `_migrations` and
 *     then died inside schema.sql — the 25 pre-cutover files have never run,
 *     and recording them as applied leaves error_events, claude_sessions,
 *     usage_events, memory_changes, schema_conformance_events and
 *     stella_operational_events permanently absent, every insert failing
 *     forever with nothing saying why;
 *
 *     a PRE-LEDGER deployment whose first ledger-aware run created
 *     `_migrations` and then died inside schema.sql — the same 25 files have
 *     all run, repeatedly, and running them again replays 0021's
 *     `DROP TABLE schema_conformance_events`, destroying retained data.
 *
 *   Reading that state one way loses tables silently; reading it the other way
 *   destroys data. The first version of this code took the second branch; the
 *   fix that landed before this one took the first. Both were guesses, because
 *   the state does not carry the information needed to decide. Codex caught
 *   the second one on #3192 (r4035933342), which is the argument for not
 *   adjudicating the state at all.
 *
 *   So the answer is recorded WITH the table, in the same statement that
 *   creates it. A `CREATE TABLE ... COMMENT '...'` either lands whole or does
 *   not land, so a `_migrations` written from here on always knows what it
 *   was born from, and the ambiguous state cannot arise. There is no window
 *   between "table exists" and "origin known" for a crash to fall into, which
 *   a marker row inserted after the CREATE would still have left open.
 *
 *   `CREATE TABLE IF NOT EXISTS` never rewrites an existing table's comment,
 *   which is the property wanted: an origin is set once, at birth, and is not
 *   revised by a later run that can no longer observe what it is describing.
 */
const LEDGER_ORIGIN_PRE_LEDGER = "oxagen ledger origin: pre-ledger deployment";
const LEDGER_ORIGIN_FRESH = "oxagen ledger origin: fresh database";

/** Raised when a ledger predating the origin comment cannot be classified. */
export class AmbiguousLedgerOriginError extends Error {
  readonly code = "CLICKHOUSE_LEDGER_ORIGIN_AMBIGUOUS";
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousLedgerOriginError";
  }
}

/**
 * What a run should do about the pre-ledger backlog, from the four facts that
 * are observable before it touches anything.
 *
 * Pure and exported so every state below is a test rather than a mock of the
 * whole client — the states are the point, and there are only eight of them.
 *
 *   "bootstrap" — a pre-ledger deployment. Record every file up to the cutover
 *                 as applied WITHOUT running it, then proceed.
 *   "proceed"   — the ledger is the truth. Apply what it does not list.
 *   "refuse"    — the state is ambiguous and both readings lose something.
 *                 Stop and say so rather than pick.
 */
export function decideLedgerAction(facts: {
  hasLedgerTable: boolean;
  hasOtherTables: boolean;
  ledgerComment: string;
  appliedCount: number;
}): {
  action: "bootstrap" | "proceed" | "refuse";
  reason: string;
  /**
   * An origin to write onto an ALREADY-EXISTING ledger before anything
   * fallible runs, or null.
   *
   * A ledger this call creates is stamped by the CREATE itself. A ledger that
   * predates the stamp is not, because `CREATE TABLE IF NOT EXISTS` never
   * rewrites a comment — the same property that stops an origin being revised
   * by a run that can no longer observe what it describes. That is right for a
   * ledger that HAS an origin and wrong for one that never got one: the origin
   * stays unwritten, and a crash inside schema.sql then converts a database we
   * can decide today into one we must refuse tomorrow (#3192 r4036387110).
   *
   * So a legacy ledger is backfilled at the one moment its origin is still
   * knowable. It is only knowable in one state — empty, with nothing else in
   * the database, so nothing has ever succeeded and "fresh" is the only
   * history that fits. A populated legacy ledger is deliberately NOT stamped:
   * its origin is unknowable and also irrelevant, since rows keep it decidable
   * for ever, and inventing an origin is worse than having none.
   */
  backfillOrigin: string | null;
} {
  const { hasLedgerTable, hasOtherTables, ledgerComment, appliedCount } = facts;

  // This call is about to create the ledger, so right now — and only right
  // now — the database still says what it is. Tables without a ledger is a
  // deployment that reached that state through prior successful migrate()
  // runs under replay-everything semantics; nothing at all is a new database.
  if (!hasLedgerTable) {
    // The CREATE below stamps this one, so nothing to backfill.
    return hasOtherTables
      ? {
          action: "bootstrap",
          reason: "tables present, no ledger yet",
          backfillOrigin: null,
        }
      : { action: "proceed", reason: "empty database", backfillOrigin: null };
  }

  // The ledger exists and remembers what it was born from.
  if (ledgerComment === LEDGER_ORIGIN_PRE_LEDGER) {
    // An empty ledger here is not ambiguous: the origin says the backlog was
    // already applied, so the first run simply died before recording it. This
    // is the case that would otherwise replay 0021's DROP.
    return appliedCount === 0
      ? {
          action: "bootstrap",
          reason: "pre-ledger origin, backlog unrecorded",
          backfillOrigin: null,
        }
      : {
          action: "proceed",
          reason: "pre-ledger origin, backlog recorded",
          backfillOrigin: null,
        };
  }
  if (ledgerComment === LEDGER_ORIGIN_FRESH) {
    // Born empty, so there is no backlog to record and never was. Whatever the
    // ledger lists is what has run.
    return { action: "proceed", reason: "fresh origin", backfillOrigin: null };
  }

  // No origin: a ledger created by a version of this file that did not write
  // one. Most of these are ordinary working deployments.
  if (appliedCount > 0) {
    // It has applied things, so it is in use and its rows are the truth. A
    // bootstrap here would be recording a backlog that this ledger has already
    // accounted for.
    return {
      action: "proceed",
      reason: "pre-comment ledger, in use",
      backfillOrigin: null,
    };
  }
  if (hasOtherTables) {
    // The one genuinely undecidable state, and the only one that can still
    // occur: a pre-comment ledger, empty, in a database that has tables.
    return {
      action: "refuse",
      reason: "pre-comment ledger, empty, tables present",
      backfillOrigin: null,
    };
  }
  // A pre-comment ledger, empty, in a database with nothing else in it. Both
  // histories agree here: nothing has ever succeeded, so everything must run.
  // Knowable exactly here, and only here. Stamp it now so a crash inside
  // schema.sql cannot turn this decidable database into a refusing one.
  return {
    action: "proceed",
    reason: "pre-comment ledger, empty database",
    backfillOrigin: LEDGER_ORIGIN_FRESH,
  };
}

/** The operator-facing text for a `refuse`. */
export function ambiguousLedgerMessage(
  database = "the target database",
): string {
  const stamp = (origin: string) =>
    `ALTER TABLE ${LEDGER_TABLE} MODIFY COMMENT '${origin}';`;
  return [
    `ClickHouse migrations stopped: ${LEDGER_TABLE} in ${database} carries no origin and has no rows.`,
    "",
    "That state has two histories and they want opposite treatment:",
    "",
    "  (a) a NEW database whose first ledger-aware migration created",
    `      ${LEDGER_TABLE} and then failed inside schema.sql. Its migrations`,
    "      have never run. Recording them as applied would leave error_events,",
    "      claude_sessions, usage_events, memory_changes,",
    "      schema_conformance_events and stella_operational_events absent",
    "      forever.",
    "",
    "  (b) an EXISTING pre-ledger deployment whose first ledger-aware",
    `      migration created ${LEDGER_TABLE} and then failed inside schema.sql.`,
    "      Its migrations have all run. Running them again replays 0021's",
    "      DROP TABLE schema_conformance_events and destroys retained data.",
    "",
    "Guessing loses tables in one case and data in the other, so this refuses.",
    "",
    "To tell them apart, ask whether the migration-only tables are there:",
    "",
    "  SELECT name FROM system.tables",
    "  WHERE database = currentDatabase()",
    "    AND name IN ('error_events','claude_sessions','usage_events',",
    "                 'memory_changes','schema_conformance_events',",
    "                 'stella_operational_events');",
    "",
    "Then STAMP THE ORIGIN and re-run. Do not drop the ledger: the partially",
    "created schema.sql tables stay behind, so the next run would see tables",
    "with no ledger, read that as a pre-ledger deployment, and record the",
    "backlog without running it — which is case (a)'s data loss, reached by",
    "the instructions meant to escape it.",
    "",
    "  none of them  -> case (a). Nothing has run, so run everything:",
    `                   ${stamp(LEDGER_ORIGIN_FRESH)}`,
    "",
    "  all of them   -> case (b). The backlog is applied; record, do not run:",
    `                   ${stamp(LEDGER_ORIGIN_PRE_LEDGER)}`,
    "",
    "  a partial set -> stamp FRESH, as in (a). Every migration file is",
    "                   individually idempotent, so re-running them is safe",
    "                   except that 0021 drops and recreates",
    "                   schema_conformance_events, costing at most its 90-day",
    "                   window of best-effort telemetry. Stamping pre-ledger",
    "                   instead would silently leave the missing tables absent",
    "                   for good, and a recoverable loss beats a permanent one.",
    "",
    "A ledger created from this version on records its own origin, and a legacy",
    "ledger is stamped automatically while its origin is still knowable, so",
    "this cannot happen again to a database that has not already reached this",
    "state.",
  ].join("\n");
}

async function ensureLedgerTable(
  ch: ClickHouseClient,
  origin: string,
): Promise<void> {
  // The origin literal matters only when this statement actually creates the
  // table; `IF NOT EXISTS` leaves an existing one — comment included —
  // untouched, which is what keeps an origin from being rewritten by a run
  // that can no longer see what it describes.
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE}
      (
          filename    String,
          applied_at  DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = MergeTree
      ORDER BY filename
      COMMENT '${origin}'
    `,
  });
}

/**
 * What the target database looked like BEFORE this call created anything:
 * whether `_migrations` was already there, whether any OTHER table was, and
 * what origin the ledger records if it is present.
 *
 * Snapshotted in one query, before `ensureLedgerTable`, so it describes the
 * database as it arrived rather than as this run leaves it. `hasOtherTables`
 * excludes the ledger explicitly rather than relying on the call ordering: the
 * previous version counted every table and justified it with "the ledger never
 * counts, because this runs first", which held on the FIRST call and was
 * assumed of every later one.
 */
async function inspectDatabase(ch: ClickHouseClient): Promise<{
  hasLedgerTable: boolean;
  hasOtherTables: boolean;
  ledgerComment: string;
}> {
  const result = await ch.query({
    query: `
      SELECT
          countIf(name = '${LEDGER_TABLE}')  AS ledger,
          countIf(name != '${LEDGER_TABLE}') AS c,
          anyIf(comment, name = '${LEDGER_TABLE}') AS ledger_comment
      FROM system.tables
      WHERE database = currentDatabase()
    `,
    format: "JSONEachRow",
  });
  const rows = await result.json<{
    ledger?: string;
    c?: string;
    ledger_comment?: string;
  }>();
  return {
    hasLedgerTable: Number(rows[0]?.ledger ?? "0") > 0,
    hasOtherTables: Number(rows[0]?.c ?? "0") > 0,
    ledgerComment: rows[0]?.ledger_comment ?? "",
  };
}

/** Filenames already recorded in the ledger. */
async function appliedMigrations(ch: ClickHouseClient): Promise<Set<string>> {
  const result = await ch.query({
    query: `SELECT DISTINCT filename FROM ${LEDGER_TABLE}`,
    format: "JSONEachRow",
  });
  const rows = await result.json<{ filename: string }>();
  return new Set(rows.map((r) => r.filename));
}

async function recordApplied(
  ch: ClickHouseClient,
  filenames: readonly string[],
): Promise<void> {
  if (filenames.length === 0) return;
  await ch.insert({
    table: LEDGER_TABLE,
    values: filenames.map((filename) => ({ filename })),
    format: "JSONEachRow",
  });
}

// ── Ledger repair: a filename is not a table (#3698) ──────────────────────────
//
// A row in `_migrations` says a file was RECORDED, not that its statements ever
// reached the server. The pre-ledger baseline above writes those rows on faith,
// for every file up to the cutover, and the apply loop below skips a recorded
// file for ever. So one wrong reading of a database — a deployment classified
// as pre-ledger whose backlog had in fact never run against THIS store — makes
// the tables those files create permanently absent, with the ledger reporting
// the store current and nothing left that would ever run them again.
//
// That is #3698 exactly. `error_events` is created only by
// `0020_error_events.sql`; `schema.sql` does not carry it. Production listed
// that file as applied and had no table, so every `captureError()` write failed
// with `Table oxagen.error_events does not exist` — and captureError is the one
// component whose failure it cannot report, so it went to stderr and nowhere
// else while `error_events` was the first place anyone looked during an
// incident.
//
// The runner now asks the database instead of trusting the ledger: a recorded
// file whose tables are missing is replayed. It is self-limiting — once the
// table exists the file is not selected again — and it is safe by construction,
// because a file is replayed only when a table it names is ABSENT. That is what
// keeps `0021`'s `DROP TABLE schema_conformance_events` off a live table: the
// drop replays only in the state where there is nothing to drop.

/** One table-level DDL statement, reduced to the verb and the table. */
export interface TableStatement {
  verb: "create" | "drop" | "alter";
  table: string;
}

/** `db`.`name` → name. ClickHouse accepts backticks and a database prefix. */
function bareTableName(raw: string): string {
  const last = raw.split(".").at(-1) ?? raw;
  return last.replace(/`/g, "");
}

/**
 * The table-level DDL in one migration file, in statement order.
 *
 * Statement order matters: `0021` drops `schema_conformance_events` and
 * recreates it four lines later, so a file read as a whole would say the table
 * is dropped. `CREATE VIEW` and `CREATE MATERIALIZED VIEW` are deliberately not
 * matched — a view is in `system.tables` too, but nothing here has run against
 * a production store carrying one, and narrower and true beats broad and
 * guessed (the same call `check-store-drift.sh` makes).
 *
 * @internal exported for tests.
 */
export function tableStatements(sql: string): TableStatement[] {
  const found: TableStatement[] = [];
  for (const statement of splitStatements(sql)) {
    // A rebuild changes the table's layout and keeps the table, which is an
    // ALTER as far as the repair is concerned. Naming it lets a replay of the
    // table's files include the rebuild, which does nothing when the table
    // came back with the new key.
    const rebuild = parseRebuildDirective(statement);
    if (rebuild !== null) {
      found.push({ verb: "alter", table: rebuild.table });
      continue;
    }
    const create =
      /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w`.]+)/i.exec(
        statement,
      );
    if (create?.[1]) {
      found.push({ verb: "create", table: bareTableName(create[1]) });
      continue;
    }
    const drop = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w`.]+)/i.exec(
      statement,
    );
    if (drop?.[1]) {
      found.push({ verb: "drop", table: bareTableName(drop[1]) });
      continue;
    }
    const alter = /^\s*ALTER\s+TABLE\s+([\w`.]+)/i.exec(statement);
    if (alter?.[1]) {
      found.push({ verb: "alter", table: bareTableName(alter[1]) });
    }
  }
  return found;
}

/**
 * The tables `migrations/` leaves behind once every file has run, folded in
 * filename and then statement order so a table created early and dropped later
 * (`session_recaps`, `agent_executions`) does not count as declared.
 *
 * @internal exported for tests.
 */
export function declaredMigrationTables(
  files: readonly { file: string; sql: string }[],
): Set<string> {
  const declared = new Set<string>();
  for (const { sql } of files) {
    for (const { verb, table } of tableStatements(sql)) {
      if (verb === "create") declared.add(table);
      else if (verb === "drop") declared.delete(table);
    }
  }
  return declared;
}

/**
 * Which recorded files have to run again, and which tables say so.
 *
 * A file is selected when it names a table that `migrations/` declares and the
 * database does not have. Selecting on the table rather than on the file is
 * what pulls in a later ALTER: replaying `0020_error_events.sql` alone would
 * recreate `error_events` without `execution_id`, because `0022` adds that
 * column and is recorded too — and a column missing from the table is worse
 * than a missing table, since ClickHouse drops the unknown field and stores the
 * rest, so the insert succeeds and the column is empty for ever.
 *
 * @internal exported for tests.
 */
export function filesToReplay(
  files: readonly { file: string; sql: string }[],
  recorded: ReadonlySet<string>,
  existing: ReadonlySet<string>,
): { files: string[]; missing: string[] } {
  const declared = declaredMigrationTables(files);
  const missing = [...declared].filter((t) => !existing.has(t)).sort();
  if (missing.length === 0) return { files: [], missing };
  const missingSet = new Set(missing);
  const selected = files
    .filter(
      ({ file, sql }) =>
        recorded.has(file) &&
        tableStatements(sql).some(({ table }) => missingSet.has(table)),
    )
    .map(({ file }) => file);
  return { files: selected, missing };
}

/** Table names currently in the target database. */
async function existingTableNames(ch: ClickHouseClient): Promise<Set<string>> {
  const result = await ch.query({
    query: `SELECT name FROM system.tables WHERE database = currentDatabase()`,
    format: "JSONEachRow",
  });
  const rows = await result.json<{ name?: unknown }>();
  return new Set(
    rows.map((r) => r.name).filter((n): n is string => typeof n === "string"),
  );
}

// Applies schema.sql on every call (it is fully idempotent — CREATE TABLE /
// ADD COLUMN IF NOT EXISTS, no DROP), then every NOT-YET-APPLIED file in
// migrations/ in filename order, recording each one in the `_migrations`
// ledger as it completes so it is never re-executed by a later call.
//
// Before this ledger existed, EVERY statement in migrations/ replayed on
// EVERY call. That made each statement's own idempotency the only thing
// keeping a re-run safe (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
// EXISTS), and nothing checked it — a non-idempotent statement re-executed on
// every deploy. `DROP TABLE IF EXISTS` is idempotent as a statement but was
// NOT safe under replay when the same file recreates the table under the same
// name (0021): it destroyed schema_conformance_events's data every run. A
// `DROP TABLE IF EXISTS` with nothing recreating that name (0007, 0010, dead
// tables with zero readers/writers) was always replay-safe and stays
// unguarded by the ledger — dropping an already-dropped table is a genuine
// no-op, not data loss.
//
// schema.sql holds most, but not all, table definitions — audit_events,
// error_events, usage_events, memory_changes, schema_conformance_events,
// stella_operational_events and the claude_* tables are defined only in
// migrations/. Treat schema.sql plus migrations/ together as the desired state.
//
// That split is why the ledger needs the repair below (#3698). A table
// schema.sql carries comes back by itself on the next call, because schema.sql
// runs outside the ledger. A table only migrations/ carries does not: once its
// filename is recorded, nothing here would ever run that file again, so a
// filename recorded without being executed makes the table permanently absent.
// The run therefore ends by asking the database which declared tables it has,
// and re-runs the recorded files that name a missing one.
async function migrateOnce(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  await ensureDatabase();
  const ch = clickhouse();

  // Snapshot taken BEFORE this call creates anything, so it describes the
  // database as it arrived rather than as this run leaves it. This is the last
  // moment at which an unledgered database still says what it is.
  const snapshot = await inspectDatabase(ch);

  // The origin is decided here and burned into the CREATE below, so it is
  // settled before ANY fallible work runs. A crash inside schema.sql or inside
  // a migration can no longer leave behind a ledger whose meaning has to be
  // guessed at — see LEDGER_ORIGIN_PRE_LEDGER for the two histories that
  // otherwise collide, and #3192 (r4035933342) for the second of them.
  await ensureLedgerTable(
    ch,
    snapshot.hasOtherTables ? LEDGER_ORIGIN_PRE_LEDGER : LEDGER_ORIGIN_FRESH,
  );

  const migrationsDir = join(here, "migrations");
  const files = existsSync(migrationsDir)
    ? readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort()
    : [];

  const applied = await appliedMigrations(ch);
  const decision = decideLedgerAction({
    hasLedgerTable: snapshot.hasLedgerTable,
    hasOtherTables: snapshot.hasOtherTables,
    ledgerComment: snapshot.ledgerComment,
    appliedCount: applied.size,
  });

  if (decision.backfillOrigin !== null) {
    // Before schema.sql, because the whole point is that a failure there must
    // not find this ledger still originless.
    //
    // A failure to write the comment is warned about and not rethrown. The
    // stamp narrows a FUTURE ambiguity; this run's decision is already made
    // and correct without it. Failing the migration because a comment could
    // not be written would turn a working deployment into a broken one to
    // prevent a state that deployment is not in.
    try {
      await ch.command({
        query: `ALTER TABLE ${LEDGER_TABLE} MODIFY COMMENT '${decision.backfillOrigin}'`,
      });
    } catch (err) {
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          msg: `could not stamp the origin on a pre-existing ${LEDGER_TABLE}; migrations continue, but a failure during this run may leave this database undecidable (see AmbiguousLedgerOriginError)`,
          err: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
    }
  }

  if (decision.action === "refuse") {
    // Both readings of this state lose something — tables in one direction,
    // retained data in the other — so it stops and hands the operator the
    // query that distinguishes them rather than picking a branch for them.
    throw new AmbiguousLedgerOriginError(ambiguousLedgerMessage());
  }

  // The one-time bootstrap: a deployment that predates the ledger has already
  // applied everything up to the cutover, repeatedly, under replay-everything
  // semantics — record that WITHOUT re-running it. Done BEFORE schema.sql so a
  // failure there cannot strand the ledger empty. See
  // PRE_LEDGER_BASELINE_CUTOVER for why a file sorting after the cutover is
  // deliberately excluded and always executes for real below.
  if (decision.action === "bootstrap" && applied.size === 0) {
    const baseline = files.filter((f) => f <= PRE_LEDGER_BASELINE_CUTOVER);
    // This filter is the ONE place in the runner that decides a file will be
    // recorded as applied without being executed, and until now it decided it
    // in silence: the deploy log showed a successful migration whether the
    // baseline covered the 26 files it was pinned against or a 27th that
    // nobody meant to skip. A guard on filenames
    // (tools/scripts/check-ch-migration-ordinals.mjs) refuses the inputs we
    // have thought of; this says out loud what the decision actually was, for
    // the ones we have not. It runs at most once per database, so there is no
    // volume argument against naming every file.
    process.stdout.write(
      JSON.stringify({
        level: "info",
        msg: "ClickHouse pre-ledger baseline: recording these migrations as applied WITHOUT executing them",
        cutover: PRE_LEDGER_BASELINE_CUTOVER,
        reason: decision.reason,
        recordedWithoutExecuting: baseline,
        willExecute: files.filter((f) => f > PRE_LEDGER_BASELINE_CUTOVER),
      }) + "\n",
    );
    await recordApplied(ch, baseline);
    for (const f of baseline) applied.add(f);
  }

  const schemaSql = readFileSync(join(here, "schema.sql"), "utf8");
  for (const stmt of splitStatements(schemaSql)) {
    await ch.command({ query: stmt });
  }

  // Read every file once, here rather than in the loop, because the repair
  // below has to look at the SQL of files the loop would skip.
  const bodies = files.map((file) => ({
    file,
    sql: readFileSync(join(migrationsDir, file), "utf8"),
  }));

  // Ask the database what it actually has, AFTER schema.sql, so a table both
  // files declare is present by the time it is checked. An empty answer is not
  // taken at face value: a populated ledger and a database with no tables at
  // all cannot both be true, so a read that returns nothing is a failed or
  // garbled read, and standing down beats replaying every migration on it.
  const existing = await existingTableNames(ch);
  const replayed = new Set<string>();
  if (existing.size === 0) {
    if (applied.size > 0) {
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          msg: "could not read the table list; skipping the ledger-vs-tables check for this run",
          recordedMigrations: applied.size,
        }) + "\n",
      );
    }
  } else {
    const repair = filesToReplay(bodies, applied, existing);
    if (repair.files.length > 0) {
      // Said out loud for the reason the baseline notice is: a recorded file
      // running again is a decision, and the failure this repairs was invisible
      // for weeks because the only thing that knew about it was a stderr line
      // inside the error reporter.
      process.stdout.write(
        JSON.stringify({
          level: "warn",
          msg: "ClickHouse ledger repair: these migrations are recorded as applied but their tables are missing, so they run again",
          missingTables: repair.missing,
          replaying: repair.files,
        }) + "\n",
      );
      for (const file of repair.files) {
        applied.delete(file);
        replayed.add(file);
      }
    }
  }

  // A file is recorded only AFTER all of its statements have returned. A
  // failure part-way through one throws out of this loop and out of
  // migrate(), so the file stays unrecorded and the next run replays it from
  // its first statement — which is the right default: a half-applied file
  // that the ledger called applied would be invisible forever.
  //
  // The cost of that default is that the replay needs every statement in the
  // file to be individually idempotent, and nothing here checks that. Every
  // file on disk today qualifies (`CREATE TABLE IF NOT EXISTS`,
  // `ALTER ... ADD COLUMN/INDEX IF NOT EXISTS`, `DROP TABLE IF EXISTS`), so
  // this is a constraint on what a future migration may contain rather than a
  // live defect: a file whose second statement cannot run twice will fail
  // differently on the retry, and the operator will be reading the SECOND
  // error rather than the one that actually stopped the deploy. Closing it
  // properly means per-statement ledger granularity, which ClickHouse's lack
  // of DDL transactions makes its own piece of work; #2972 carries it.
  //
  // A `REBUILD TABLE` directive is the one statement that is not sent as it
  // is written. It goes to `rebuildPartitionKey`, which works out from the
  // tables where an earlier run stopped, so a file that holds one replays
  // cleanly under the rule above (#4297).
  let rebuilds: ClickHouseClient | null = null;
  try {
    for (const { file, sql } of bodies) {
      if (applied.has(file)) continue;
      for (const stmt of splitStatements(sql)) {
        const rebuild = parseRebuildDirective(stmt);
        if (rebuild === null) {
          await ch.command({ query: stmt });
          continue;
        }
        rebuilds ??= rebuildClient();
        const outcome = await rebuildPartitionKey(
          clickhouseRebuildStore(rebuilds),
          rebuild,
        );
        process.stdout.write(
          JSON.stringify({
            level: "info",
            msg: "ClickHouse rebuild finished",
            file,
            table: rebuild.table,
            partitionBy: rebuild.partitionBy,
            outcome,
          }) + "\n",
        );
      }
      // A replayed file is already in the ledger. `appliedMigrations` reads
      // `SELECT DISTINCT`, so a second row would be harmless, but a ledger that
      // grows a row every time a repair runs is a ledger that stops reading as a
      // list of what has been applied.
      if (!replayed.has(file)) await recordApplied(ch, [file]);
    }
  } finally {
    await rebuilds?.close();
  }
}

// Queue local callers and take the shared Postgres lock before inspecting
// ClickHouse. A second process cannot snapshot the ledger until the first
// has recorded its work and released the lock. Missing or unavailable
// Postgres fails closed before any ClickHouse DDL.
let migrationQueue: Promise<void> = Promise.resolve();

export function migrate(): Promise<void> {
  const run: Promise<void> = migrationQueue.then(
    () => withMigrationLock(migrateOnce),
    () => withMigrationLock(migrateOnce),
  );
  // Keep the queue moving even when this run fails — only THIS call's own
  // caller (the `run` promise returned below) should observe that failure;
  // a later caller must still get its turn rather than inherit a
  // permanently wedged queue.
  migrationQueue = run.catch(() => undefined);
  return run;
}

// Bundle-safe direct-run guard (see is-direct-run.ts): the bare
// import.meta.url === file://argv[1] equality misfires inside the standalone
// `oxagen` bundle and would run this ClickHouse migration → process.exit(1) on
// every CLI boot, crashing any run without CLICKHOUSE_* env.
if (isDirectRunEntry(import.meta.url, process.argv[1], "migrate")) {
  migrate()
    .then(() => closeClickhouse())
    .then(() => {
      process.stdout.write(
        JSON.stringify({
          level: "info",
          msg: "ClickHouse migration complete",
        }) + "\n",
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        JSON.stringify({
          level: "error",
          msg: "ClickHouse migration failed",
          err: String(err),
        }) + "\n",
      );
      process.exit(1);
    });
}
