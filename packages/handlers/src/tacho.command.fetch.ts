// `fetch_commands`: the idle-host control poll (spec section 7.4). The host
// reports what became of the commands it took — `received`, `acknowledged`,
// `applied` with the frame it landed on, or `failed` with a detail — and
// receives the queued ones with the control envelope.
//
// An acknowledgement lands only on a row that has not reached a terminal
// status: a row Oxagen already cancelled (superseded) or expired while it
// was still `queued` stays as it is, and the report keeps what Oxagen
// recorded. A row that left on the wire is the host's: the sweep never
// touches it, so an acknowledgement that arrives after the clock passed
// still lands (`expireCommands` in ./lib/tacho-host.ts). `applied` writes
// the timestamps a report reads (`acknowledged_at`, `applied_at`) and the
// frame sequence (`applied_at_seq`) that proves it.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoCommandFetch } from "@oxagen/oxagen/contracts/tacho.command.fetch";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, notInArray } from "drizzle-orm";
import {
  controlEnvelope,
  resolveEnrolledHost,
  touchHost,
} from "./lib/tacho-host";

type Ack =
  (typeof tachoCommandFetch.input)["_output"]["acknowledgements"][number];

/** The columns one acknowledgement sets, by the status the host asserts. */
export function ackPatch(
  ack: Ack,
  now: Date,
): Partial<typeof schema.tachoControlCommands.$inferInsert> {
  const base = {
    outcome: ack.status,
    outcomeDetail: ack.detail ?? null,
    updatedAt: now,
  };
  switch (ack.status) {
    case "received":
      return base;
    case "acknowledged":
      return { ...base, acknowledgedAt: now };
    case "applied":
      return {
        ...base,
        acknowledgedAt: now,
        appliedAt: now,
        appliedAtSeq: ack.applied_at_seq ?? null,
      };
    case "failed":
      return base;
  }
}

export const tachoCommandFetchHandler: CapabilityHandler<
  typeof tachoCommandFetch
> = async (input, ctx) => {
  const now = new Date();
  return withTenantDb(async (tx) => {
    const host = await resolveEnrolledHost(
      tachoCommandFetch.name,
      ctx,
      tx as never,
      input.host_enrollment_id,
    );
    let acknowledged = 0;
    for (const ack of input.acknowledgements) {
      const updated = await tx
        .update(schema.tachoControlCommands)
        .set(ackPatch(ack, now))
        .where(
          and(
            eq(schema.tachoControlCommands.publicId, ack.command_id),
            eq(schema.tachoControlCommands.hostId, host.id),
            notInArray(schema.tachoControlCommands.outcome, [
              ...schema.TACHO_COMMAND_TERMINAL_OUTCOMES,
            ]),
          ),
        )
        .returning({ id: schema.tachoControlCommands.id });
      acknowledged += updated.length;
    }
    await touchHost(tx as never, host, input.daemon, now, false);
    const control = await controlEnvelope(tx as never, ctx, host, now);
    return { acknowledged, control };
  });
};
