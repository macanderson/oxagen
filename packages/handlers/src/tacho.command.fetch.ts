// `fetch_commands`: the idle-host control poll (spec section 7.4). The host
// reports what became of the commands it took — `received`, `acknowledged`,
// `applied` with the frame it landed on, `expired` when the deadline passed
// with no boundary reached, or `failed` with a detail — and receives the
// queued ones, and any sent one it never acknowledged, with the control
// envelope (`drainCommands` in ./lib/tacho-host.ts).
//
// The envelope is built in a transaction of its own, after the one that lands
// the acknowledgements. Its etag covers the host's published skills, and those
// are read between the two, outside any tenant transaction
// (./lib/tacho-host-skills.ts says why). A failed envelope leaves the
// acknowledgements landed. The host sends them again with its next poll, as
// it does after any poll whose answer it never read, and `ackableOutcomes`
// keeps a repeat from moving a row back.
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
import { hostCedarReader } from "./lib/tacho-host-cedar";
import { hostSkillsReader } from "./lib/tacho-host-skills";
import { type AckedCommand, recordWorkOrderAcks } from "./lib/work-records/runtime";
import { logger } from "./logger";
import {
  type TachoPublished,
  VERSION_STORE_PUBLISHED,
} from "./tacho.published";

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

export interface TachoCommandFetchDeps {
  /** The workspace's and the organization's published steering, for the skills and the Cedar policies the envelope's etag covers. */
  published: TachoPublished;
}

/** The same version store `get_tacho_bundle` reads, so both serve one etag. */
export const defaultTachoCommandFetchDeps: TachoCommandFetchDeps = {
  published: VERSION_STORE_PUBLISHED,
};

export function createTachoCommandFetchHandler(
  deps: TachoCommandFetchDeps,
): CapabilityHandler<typeof tachoCommandFetch> {
  const skillsReader = hostSkillsReader(deps.published);
  const cedarReader = hostCedarReader(deps.published);
  return async (input, ctx) => {
    const now = new Date();
    const { acknowledged, seen } = await withTenantDb(async (tx) => {
      const host = await resolveEnrolledHost(
        tachoCommandFetch.name,
        ctx,
        tx as never,
        input.host_enrollment_id,
      );
      let acknowledged = 0;
      const moved: AckedCommand[] = [];
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
          .returning({
            id: schema.tachoControlCommands.id,
            publicId: schema.tachoControlCommands.publicId,
            command: schema.tachoControlCommands.command,
            outcome: schema.tachoControlCommands.outcome,
            payload: schema.tachoControlCommands.payload,
            detail: schema.tachoControlCommands.outcomeDetail,
            targetId: schema.tachoControlCommands.targetId,
          });
        acknowledged += updated.length;
        for (const row of updated) {
          moved.push({
            publicId: String(row.publicId),
            command: row.command,
            outcome: row.outcome,
            payload: row.payload,
            detail: row.detail,
            targetId: row.targetId,
          });
        }
      }
      // A work order's command the host took is `send_delivered`, one it
      // could not keep is `send_rejected`, and a stop's `cancel` it applied is
      // `stopped` (ADR-251). Each is recorded in a savepoint of its own: a work
      // record that refuses one must not undo the acknowledgements, or the
      // host would send them again on every poll, and must not drop the
      // others.
      for (const command of moved) {
        if (command.command !== "work_order" && command.command !== "cancel") continue;
        try {
          await tx.transaction((savepoint) =>
            recordWorkOrderAcks(
              savepoint as never,
              { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
              { id: host.id, publicId: String(host.publicId), runtimeId: host.runtimeId, agentId: host.agentId },
              [command],
              now,
            ),
          );
        } catch (error) {
          logger.warn(
            { err: error, host: host.publicId, command: command.publicId },
            "fetch_commands: a work order acknowledgement was not recorded on its work item",
          );
        }
      }
      const seen = await touchHost(tx as never, host, input.daemon, now, false);
      return { acknowledged, seen };
    });
    // `seen` carries the features this poll advertised, which decide whether
    // the host parses skills and Cedar at all. Both are read at once, so the
    // production port answers them with one read.
    const [skills, policy] = await Promise.all([
      skillsReader.read(tachoCommandFetch.name, ctx, seen),
      cedarReader.read(tachoCommandFetch.name, ctx, seen),
    ]);
    const control = await withTenantDb((tx) =>
      controlEnvelope(tx as never, ctx, seen, now, skills, policy),
    );
    return { acknowledged, control };
  };
}

export const tachoCommandFetchHandler = createTachoCommandFetchHandler(
  defaultTachoCommandFetchDeps,
);
