/**
 * tacho-gateway-columns.ts — reading and writing the two columns migration
 * `20260917120000` adds, on a database that may not have them yet.
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
 */

import {
  hasColumn,
  HOST_GATEWAY_COLUMN,
  SESSION_GATEWAY_COLUMN,
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
export function hostGatewayColumnReady(tx: ProbeTx): Promise<boolean> {
  return hasColumn(tx, HOST_GATEWAY_COLUMN);
}

/** Whether `tacho.sessions.gateway_observed_at` is present. */
export function sessionGatewayColumnReady(tx: ProbeTx): Promise<boolean> {
  return hasColumn(tx, SESSION_GATEWAY_COLUMN);
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
): Promise<{ gatewayObservedAt: false } | undefined> {
  return (await sessionGatewayColumnReady(tx))
    ? undefined
    : { gatewayObservedAt: false };
}
