/**
 * tacho-gateway-columns.ts — reading and writing the two columns migration
 * `20260917140000` adds, on a database that may not have them yet.
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
  SESSION_MACHINE_SNAPSHOT_COLUMN,
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

/**
 * Reads may cache a missing column. Writes recheck a miss immediately: omitting
 * a fresh fact after migration would leave a permanent hole in the record.
 */
export async function sessionGatewayColumnReady(
  tx: ProbeTx,
  forWrite = false,
): Promise<boolean> {
  return (forWrite ? hasColumnFresh : hasColumn)(
    tx,
    SESSION_GATEWAY_COLUMN,
    await ambientPlaneKey(),
  );
}

/**
 * Whether `tacho.sessions.pushes` is present.
 *
 * The same deploy-before-migrate window this module was written for, on a
 * column with a wider blast radius. The gateway columns only decide a tier,
 * so projecting them away degrades one field; `pushes` is written by the
 * rollup every accepted batch performs, so naming it before the migration
 * lands raises 42703 and refuses the batch outright. A host would report
 * healthy and record nothing.
 */
export async function sessionPushesColumnReady(
  tx: ProbeTx,
  forWrite = false,
): Promise<boolean> {
  return (forWrite ? hasColumnFresh : hasColumn)(
    tx,
    SESSION_PUSHES_COLUMN,
    await ambientPlaneKey(),
  );
}

/** Whether the session-time machine facts column is available on this plane. */
export async function sessionMachineSnapshotColumnReady(
  tx: ProbeTx,
  forWrite = false,
): Promise<boolean> {
  return (forWrite ? hasColumnFresh : hasColumn)(
    tx,
    SESSION_MACHINE_SNAPSHOT_COLUMN,
    await ambientPlaneKey(),
  );
}

/**
 * Whether `tacho.session_files.observed_status` is present.
 *
 * Probed separately from `pushes` rather than inferred from it, for the
 * reason the two gateway columns are probed separately: one migration adds
 * both, and a migration that fails between two `ADD COLUMN IF NOT EXISTS`
 * statements leaves exactly the half-applied state an inference gets wrong.
 */
export async function sessionFileObservedStatusColumnReady(
  tx: ProbeTx,
  forWrite = false,
): Promise<boolean> {
  return (forWrite ? hasColumnFresh : hasColumn)(
    tx,
    SESSION_FILE_OBSERVED_STATUS_COLUMN,
    await ambientPlaneKey(),
  );
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

/** The same for a `tacho.sessions` read. */
export async function sessionReadColumns(
  tx: ProbeTx,
): Promise<
  | { gatewayObservedAt?: false; pushes?: false; machineSnapshot?: false }
  | undefined
> {
  const gateway = await sessionGatewayColumnReady(tx);
  const pushes = await sessionPushesColumnReady(tx);
  const machine = await sessionMachineSnapshotColumnReady(tx);
  if (gateway && pushes && machine) return undefined;
  return {
    ...(!gateway ? { gatewayObservedAt: false as const } : {}),
    ...(!pushes ? { pushes: false as const } : {}),
    ...(!machine ? { machineSnapshot: false as const } : {}),
  };
}

/**
 * The `columns` fragment for a `tacho.session_files` read: everything, minus
 * the observed verdict while the database lacks it.
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
  forWrite = false,
): Promise<boolean> {
  return (forWrite ? hasColumnFresh : hasColumn)(
    tx,
    GATEWAY_CHAIN_COLUMN,
    await ambientPlaneKey(),
  );
}
