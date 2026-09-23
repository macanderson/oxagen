import { and, eq, inArray } from "drizzle-orm";
import {
  ambientPlaneKey,
  CONTAINED_LAUNCH_COLUMN,
  hasColumnFresh,
  schema,
  type Tx,
} from "@oxagen/database";

/** Registration is authenticated separately from the host's event-ingest key. */
export async function containedLaunchesFor(
  tx: Tx,
  hostId: string,
  sessions: string[],
): Promise<Map<string, string>> {
  if (
    sessions.length === 0 ||
    !(await hasColumnFresh(
      tx,
      CONTAINED_LAUNCH_COLUMN,
      await ambientPlaneKey(),
    ))
  )
    return new Map();
  const rows = await tx
    .select({
      sessionUuid: schema.tachoContainedLaunches.sessionUuid,
      genesisHash: schema.tachoContainedLaunches.genesisHash,
    })
    .from(schema.tachoContainedLaunches)
    .where(
      and(
        eq(schema.tachoContainedLaunches.hostId, hostId),
        inArray(schema.tachoContainedLaunches.sessionUuid, sessions),
      ),
    );
  return new Map(rows.map((row) => [row.sessionUuid, row.genesisHash]));
}

/** Trusted launcher evidence plus a verified chain and observed gateway traffic.
 * The launcher and daemon are trusted; this does not attest a hostile host owner.
 */
export function containedTierOf(
  gatewayTier: string,
  launchGenesis: string | undefined,
  sessionGenesis: string | null,
): string {
  return gatewayTier === "gateway" &&
    sessionGenesis !== null &&
    launchGenesis === sessionGenesis
    ? "contained"
    : gatewayTier;
}

/** Sealed tiers are final; live tiers only rise on new evidence. */
export function promotedTier(
  existing: { enforcementTier: string; sealedAt?: Date | null } | undefined,
  derived: string,
): string {
  if (!existing) return derived;
  if (existing.sealedAt || existing.enforcementTier === "contained")
    return existing.enforcementTier;
  if (
    derived === "contained" ||
    (derived === "gateway" && existing.enforcementTier !== "gateway")
  )
    return derived;
  return existing.enforcementTier;
}
