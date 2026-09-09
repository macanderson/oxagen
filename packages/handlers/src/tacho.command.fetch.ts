import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoCommandFetch } from "@oxagen/oxagen/contracts/tacho.command.fetch";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import {
  controlEnvelope,
  resolveEnrolledHost,
  touchHost,
} from "./lib/tacho-host";

/** The idle-host poll: acknowledge outcomes, receive pending commands. */
export const tachoCommandFetchHandler: CapabilityHandler<
  typeof tachoCommandFetch
> = async (input, ctx) => {
  const now = new Date();
  return withTenantDb(async (tx) => {
    const host = await resolveEnrolledHost(
      "fetch_tacho_commands",
      ctx,
      tx as never,
      input.host_enrollment_id,
    );
    let acknowledged = 0;
    for (const ack of input.acknowledgements) {
      const updated = await tx
        .update(schema.tachoControlCommands)
        .set({
          outcome: ack.outcome,
          outcomeDetail: ack.detail ?? null,
          acknowledgedAt: now,
          appliedAt: ack.outcome === "applied" ? now : null,
          appliedAtSeq: ack.applied_at_seq ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.tachoControlCommands.publicId, ack.command_id),
            eq(schema.tachoControlCommands.hostId, host.id),
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
