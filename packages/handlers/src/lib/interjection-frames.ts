/**
 * The `agent.interjections` rows a host's repository question writes (#3941).
 *
 * A host that holds a session on an unbound repository seals
 * `control.interject` on the run's own chain before the control plane has
 * heard of the question. The ingest turns each fresh one into a
 * `repo_unknown` row, keyed on the frame (workspace, run, `raised_seq`), so a
 * re-sent batch writes no second row. The row copies the frame's body, which
 * the Run page reads the question, the paths and the timeout from.
 *
 * The deadline is the control plane's own: the frame's time plus
 * `SKILL_INTERJECTION_TIMEOUT_MS`, whatever timeout the body names. The
 * caller sends `AGENT_INTERJECTION_RAISED_EVENT` for each row written, after
 * the transaction commits, and the timeout function answers `deny` at the
 * deadline when nobody has.
 *
 * A host that reached its own deadline first answers `deny` itself and seals
 * `control.answer` with source `timeout`. That frame closes the row, so the
 * record says what the host did even when the control plane's timeout never
 * ran. It mints no receipt: the receipt belongs to the audit event, which the
 * timeout function writes.
 *
 * A body that fails its schema is still a frame on the chain, and writes no
 * row. It is logged, as a refused proof is.
 */
import {
  answerBodySchema,
  interjectBodySchema,
  type TachoEvent,
} from "@oxagen/tacho";
import { SKILL_INTERJECTION_TIMEOUT_MS } from "@oxagen/oxagen/skills";
import {
  AGENT_INTERJECTION_RAISED_EVENT,
  type AgentInterjectionRaisedEventData,
} from "@oxagen/inngest-functions/events";
import { schema, type Tx } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "../logger";

export const CONTROL_INTERJECT_KIND = "control.interject";
export const CONTROL_ANSWER_KIND = "control.answer";

/** The organisation and workspace the batch was recorded in. */
export interface InterjectionScope {
  orgId: string;
  workspaceId: string;
}

/** The run the frames belong to: the root session's public id. */
export interface InterjectionRun {
  publicId: string;
  /** The host's agent key; null when the host names none. */
  agentKey: string | null;
}

/** A row this batch wrote, for the event the caller sends after commit. */
export interface RaisedInterjection {
  interjectionId: string;
  expiresAt: Date;
}

/** The answer text a host's own timeout records on the row. */
export const HOST_TIMEOUT_ANSWER =
  "Nobody answered before the deadline. The session went on without skills.";

/** Whether a frame is one this module reads. */
export function isInterjectionFrame(event: Pick<TachoEvent, "kind">): boolean {
  return (
    event.kind === CONTROL_INTERJECT_KIND || event.kind === CONTROL_ANSWER_KIND
  );
}

/**
 * Write one `repo_unknown` row per fresh `control.interject` among `frames`,
 * and close the row of each `control.answer` the host sealed on its own
 * timeout. `frames` are the run's own chain's frames past its recorded head,
 * in seq order. Answers the rows written, which a re-sent batch never has.
 */
export async function recordInterjectionFrames(
  tx: Tx,
  scope: InterjectionScope,
  run: InterjectionRun,
  frames: readonly TachoEvent[],
): Promise<RaisedInterjection[]> {
  const ij = schema.interjections;
  const raised: RaisedInterjection[] = [];
  for (const frame of frames) {
    if (frame.kind === CONTROL_INTERJECT_KIND) {
      const body = interjectBodySchema.safeParse(frame.body);
      if (!body.success) {
        refused(scope, run, frame, body.error.issues[0]?.path.join("."));
        continue;
      }
      const raisedAt = new Date(frame.ts);
      const rows = await tx
        .insert(ij)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          runPublicId: run.publicId,
          agentKey: run.agentKey,
          question: body.data.question,
          raisedAt,
          expiresAt: new Date(
            raisedAt.getTime() + SKILL_INTERJECTION_TIMEOUT_MS,
          ),
          kind: "repo_unknown",
          raisedSeq: frame.seq,
          body: body.data,
        })
        // The frame's key (`interjections_raised_frame_uq`): a frame already
        // recorded writes nothing, and returns nothing to announce.
        .onConflictDoNothing()
        .returning({ publicId: ij.publicId, expiresAt: ij.expiresAt });
      for (const row of rows)
        raised.push({
          interjectionId: row.publicId,
          expiresAt: row.expiresAt,
        });
      continue;
    }
    if (frame.kind !== CONTROL_ANSWER_KIND) continue;
    const answer = answerBodySchema.safeParse(frame.body);
    if (!answer.success) {
      refused(scope, run, frame, answer.error.issues[0]?.path.join("."));
      continue;
    }
    // Only the host's own timeout is recorded from the frame. A person's
    // answer was recorded by `answer_interjection` before the host sealed it.
    if (answer.data.source !== "timeout" || answer.data.path !== "deny")
      continue;
    await tx
      .update(ij)
      .set({
        answeredAt: new Date(frame.ts),
        answer: HOST_TIMEOUT_ANSWER,
        path: "deny",
        answeredByUserId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(ij.orgId, scope.orgId),
          eq(ij.workspaceId, scope.workspaceId),
          eq(ij.runPublicId, run.publicId),
          eq(ij.kind, "repo_unknown"),
          isNull(ij.answeredAt),
          sql`${ij.body} ->> 'interjection_key' = ${answer.data.interjection_key}`,
        ),
      );
  }
  return raised;
}

function refused(
  scope: InterjectionScope,
  run: InterjectionRun,
  frame: TachoEvent,
  issue: string | undefined,
): void {
  logger.warn(
    {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      runId: run.publicId,
      seq: frame.seq,
      kind: frame.kind,
      issue,
    },
    "tacho.events.ingest: interjection frame body failed its schema; the frame is recorded and writes no row",
  );
}

export type InterjectionRaisedEvent = {
  name: typeof AGENT_INTERJECTION_RAISED_EVENT;
  id: string;
  data: AgentInterjectionRaisedEventData;
};

/**
 * One event per row written. The id holds for the row, so a send retried
 * for the same row starts one timeout.
 */
export function interjectionRaisedEvents(
  scope: InterjectionScope,
  raised: readonly RaisedInterjection[],
): InterjectionRaisedEvent[] {
  return raised.map((row) => ({
    name: AGENT_INTERJECTION_RAISED_EVENT,
    id: `interjection-raised:${row.interjectionId}`,
    data: {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      interjectionId: row.interjectionId,
      expiresAt: row.expiresAt.toISOString(),
    },
  }));
}

/**
 * Send the batch's raised events. A failed send is logged and never fails
 * the ingest: the host answers `deny` itself at its own deadline, and its
 * `control.answer` closes the row.
 */
export async function sendInterjectionsRaised(
  send: (events: InterjectionRaisedEvent[]) => Promise<unknown>,
  scope: InterjectionScope,
  raised: readonly RaisedInterjection[],
): Promise<void> {
  const events = interjectionRaisedEvents(scope, raised);
  if (events.length === 0) return;
  try {
    await send(events);
  } catch (err) {
    logger.warn(
      { err, interjections: events.map((event) => event.data.interjectionId) },
      "tacho.events.ingest: agent/interjection.raised dispatch failed; the host's own timeout settles these questions",
    );
  }
}
