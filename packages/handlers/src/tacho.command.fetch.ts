// `fetch_commands`: the idle-host control poll (spec section 7.4). The host
// reports what became of the commands it took — `received`, `acknowledged`,
// `applied` with the frame it landed on, `expired` when the deadline passed
// with no boundary reached, or `failed` with a detail — and receives the
// queued ones, and any sent one it never acknowledged, with the control
// envelope (`drainCommands` in ./lib/tacho-host.ts).
//
// An acknowledgement lands only on a row that has not reached a terminal
// status: a row Oxagen already cancelled (superseded) or expired while it
// was still `queued` stays as it is, and the report keeps what Oxagen
// recorded. It also only moves a row forward (`ackableOutcomes`): a late
// `received` does not pull an `acknowledged` row back. A row that left on the
// wire is the host's: the sweep leaves it for a grace past its expiry
// (`COMMAND_ACK_GRACE_MS`), so an acknowledgement that arrives after the clock
// passed still lands (`expireCommands` in ./lib/tacho-host.ts). `applied`
// writes the timestamps a report reads (`acknowledged_at`, `applied_at`) and
// the frame sequence (`applied_at_seq`) that proves it.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoCommandFetch } from "@oxagen/oxagen/contracts/tacho.command.fetch";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import {
  controlEnvelope,
  resolveEnrolledHost,
  touchHost,
} from "./lib/tacho-host";

type Ack =
  (typeof tachoCommandFetch.input)["_output"]["acknowledgements"][number];

/** The open statuses, in the order a command moves through them. */
const OPEN_OUTCOMES = [
  "draft",
  "queued",
  "sent",
  "received",
  "acknowledged",
] as const;

/**
 * The statuses a row may hold for this acknowledgement to land on it: every
 * open status up to the asserted one, so a re-sent or reordered `received`
 * cannot move an `acknowledged` row back. A terminal status lands on any
 * open row.
 */
export function ackableOutcomes(status: Ack["status"]): string[] {
  const at = (OPEN_OUTCOMES as readonly string[]).indexOf(status);
  return at === -1 ? [...OPEN_OUTCOMES] : OPEN_OUTCOMES.slice(0, at + 1);
}

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
    case "expired":
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
            inArray(
              schema.tachoControlCommands.outcome,
              ackableOutcomes(ack.status),
            ),
          ),
        )
        .returning({ id: schema.tachoControlCommands.id });
      acknowledged += updated.length;
    }
    const seen = await touchHost(tx as never, host, input.daemon, now, false);
    const control = await controlEnvelope(tx as never, ctx, seen, now);
    return { acknowledged, control };
  });
};
