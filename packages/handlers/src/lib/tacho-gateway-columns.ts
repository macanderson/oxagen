/**
 * tacho-gateway-columns.ts — reading and writing the Tacho columns a pending
 * migration may not have added yet.
 *
 * It began as the two columns of migration `20260917140000`, which is where the
 * filename comes from; `20260918223000` (`tacho.sessions.pushes`) and
 * `20260918230000` (`tacho.session_files.observed_status`) need the same
 * treatment and are bound here too rather than in a module of their own. The
 * probe itself is shared (`@oxagen/database`); what differs per migration is
 * only which column is asked about and what the caller does while the answer
 * is no, so a second module would be a second copy of that decision. The name
 * is left alone deliberately: eight files import this path and the branch is
 * worked by several sessions at once, so renaming it buys tidiness and pays in
 * merge conflicts.
 *
 * `tacho.hosts.gateway_last_seen_at` and `tacho.sessions.gateway_observed_at`
 * are what the server-observed enforcement tier stands on. Production applies
 * migrations by hand from the app node (`infra/tools/run-db-migrations.sh`,
 * #1275) while `deploy-node` ships on merge without waiting, so between the two
 * there is a window where this code is live and the columns are not.
 *
 * Drizzle's relational reads select every column the schema declares, so in
 * that window an ordinary `tachoHosts.findFirst()` names a column the database
 * does not have and raises 42703 — taking out host ingestion, control-command
 * traffic and bundle fetches, none of which are about the gateway tier at all
 * (discussion_r4040352870).
 *
 * So each read asks first and projects the column away while it is missing,
 * and each write is skipped. The tier then falls back to the host's own mode,
 * which is the same answer this code gives for a host that has never had a
 * gateway call authorised: no observation reads as no evidence, never as a
 * tier. Nothing else about ingestion changes.
 *
 * The probe itself lives in `@oxagen/database` because `plan-allowance.ts`
 * needed exactly this for migration `20260916120000` and proved the shape,
 * including why it must ask rather than catch 42703 and retry.
 *
 * Every caller here is inside `withTenantDb`, so the answer is filed under the
 * plane that scope resolves to (`ambientPlaneKey`). That is load-bearing on a
 * deployment with dedicated planes: a dedicated plane is migrated separately
 * from the shared one, and an answer borrowed across the two would drop the
 * projection on a database that still lacks the column
 * (discussion_r4040617223).
 */

import {
  ambientPlaneKey,
  GATEWAY_CHAIN_COLUMN,
  hasColumn,
  hasColumnFresh,
  HOST_GATEWAY_COLUMN,
  SESSION_FILE_OBSERVED_STATUS_COLUMN,
  SESSION_GATEWAY_COLUMN,
  SESSION_PUSHES_COLUMN,
  type ProbeTx,
} from "@oxagen/database";

/**
 * Whether `tacho.hosts.gateway_last_seen_at` is present.
 *
 * Probed separately from the session column rather than inferred from it. One
 * migration adds both, but both statements are `ADD COLUMN IF NOT EXISTS` and
 * a migration that fails between them leaves exactly the half-applied state
 * that an inference would get wrong.
 */
export async function hostGatewayColumnReady(tx: ProbeTx): Promise<boolean> {
  return hasColumn(tx, HOST_GATEWAY_COLUMN, await ambientPlaneKey());
}

/** Whether `tacho.sessions.gateway_observed_at` is present. */
export async function sessionGatewayColumnReady(tx: ProbeTx): Promise<boolean> {
  return hasColumn(tx, SESSION_GATEWAY_COLUMN, await ambientPlaneKey());
}

/**
 * The `columns` fragment for a `tacho.hosts` read: everything, minus the
 * gateway column while the database lacks it.
 *
 * `undefined` rather than `{}` on the ready path. Drizzle reads an empty
 * `columns` object as "select nothing", so returning `{}` would not be a
 * narrower version of the same query — it would be a different one.
 */
export async function hostReadColumns(
  tx: ProbeTx,
): Promise<{ gatewayLastSeenAt: false } | undefined> {
  return (await hostGatewayColumnReady(tx))
    ? undefined
    : { gatewayLastSeenAt: false };
}

/**
 * The same for a `tacho.sessions` read, over both of that table's pending
 * columns.
 *
 * One projection rather than one per migration, because Drizzle takes a single
 * `columns` object and a caller holding two would have to merge them — and the
 * merge is the part that gets forgotten when a third column arrives. Nothing
 * reads either column off a session row today, so dropping them costs the
 * callers nothing; they are projected away only to stop the SELECT naming
 * them.
 */
export async function sessionReadColumns(
  tx: ProbeTx,
): Promise<
  | { gatewayObservedAt: false; pushes: false }
  | { gatewayObservedAt: false }
  | { pushes: false }
  | undefined
> {
  // Sequential, not `Promise.all`: both answers come from one per-process cache
  // and the second is free once the first has warmed the plane key, so
  // concurrency here buys nothing and costs two round trips on a cold miss.
  const gateway = await sessionGatewayColumnReady(tx);
  const pushes = await sessionPushesColumnReady(tx);
  if (gateway && pushes) return undefined;
  if (!gateway && !pushes) return { gatewayObservedAt: false, pushes: false };
  return gateway ? { pushes: false } : { gatewayObservedAt: false };
}

/**
 * Whether `tacho.sessions.pushes` is present, asked afresh every time.
 *
 * {@link hasColumnFresh} rather than {@link hasColumn}: the caller is a counter
 * increment, and a write that skips a counter for a batch never gets another
 * chance at it. The events are acknowledged, the daemon will not re-send them,
 * and no backfill knows what the omitted delta was. A read may spend the
 * negative-probe TTL being conservative because the next call is right again; a
 * lost push count is lost for good.
 */
export async function sessionPushesColumnReady(tx: ProbeTx): Promise<boolean> {
  return hasColumnFresh(tx, SESSION_PUSHES_COLUMN, await ambientPlaneKey());
}

/**
 * Whether `tacho.session_files.observed_status` is present, asked afresh.
 *
 * Fresh for the same reason as {@link sessionPushesColumnReady}: the rollup
 * writes the observed verdict for a path once, on the batch whose
 * reconciliation carried it, and a row written without it stays null. The title
 * derivation reads the same answer, and paying one extra round trip on the read
 * is worth the two paths never disagreeing inside one transaction.
 */
export async function sessionFileObservedStatusColumnReady(
  tx: ProbeTx,
): Promise<boolean> {
  return hasColumnFresh(
    tx,
    SESSION_FILE_OBSERVED_STATUS_COLUMN,
    await ambientPlaneKey(),
  );
}

/**
 * The `columns` fragment for a `tacho.session_files` read.
 *
 * `undefined` on the ready path, for the reason {@link hostReadColumns} gives:
 * Drizzle reads `{}` as "select nothing".
 */
export async function sessionFileReadColumns(
  tx: ProbeTx,
): Promise<{ observedStatus: false } | undefined> {
  return (await sessionFileObservedStatusColumnReady(tx))
    ? undefined
    : { observedStatus: false };
}

/**
 * Whether `tacho.gateway_chains` exists yet (#3221).
 *
 * A TABLE, not a column — but asked the same way, because
 * `information_schema.columns` has no row for a column of a table that does
 * not exist. One probe answers both "table missing" and "migration ran
 * halfway", and the stakes are higher than for a plain added column: naming
 * an absent table raises 42P01, which aborts the transaction exactly as 42703
 * does. Ingest would then fail for every host on the deploy-before-migrate
 * window, over a table it consults only to decide an enforcement tier.
 */
export async function gatewayInvocationColumnReady(
  tx: ProbeTx,
): Promise<boolean> {
  return hasColumn(tx, GATEWAY_CHAIN_COLUMN, await ambientPlaneKey());
}
