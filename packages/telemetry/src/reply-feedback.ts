import { chInsert, chSelect } from "./tenant";

// A person's verdict on one reply of the in-app assistant (#4169), in the
// append-only `assistant_reply_feedback` table (migration 0030).
//
// `record_reply_feedback` writes one row per vote through recordReplyFeedback,
// after it has checked the run and the conversation in Postgres. A vote is
// never updated: a person who changes their mind votes again, and
// readReplyFeedback answers the newest vote per person and run. That reader is
// the query the replay set runs to pick the turns people marked wrong.
//
// org_id and workspace_id are stamped by chInsert from the active tenant
// scope, and chSelect filters every read on both, so one workspace never reads
// another's votes. Callers run inside runInTenantScope, which the kernel has
// already entered for a scoped capability.

/** The table the rows land in. */
export const REPLY_FEEDBACK_TABLE = "assistant_reply_feedback";

/** The two verdicts a person can give a reply. */
export const REPLY_FEEDBACK_VERDICTS = ["useful", "wrong"] as const;
export type ReplyFeedbackVerdict = (typeof REPLY_FEEDBACK_VERDICTS)[number];

/**
 * One vote, as the table stores it. The tenant columns are absent because
 * chInsert stamps them from the scope and overwrites anything a caller sends.
 */
export interface ReplyFeedbackRow {
  /** `arun_...`: the run the reply was recorded as. */
  run_public_id: string;
  /** chat.conversations.id of the conversation that holds the reply. */
  conversation_id: string;
  /** chat.messages.id of the reply. */
  message_id: string;
  /** auth.users.id of the person who voted. */
  user_id: string;
  verdict: ReplyFeedbackVerdict;
  /** The person's reason, or "" when they gave none. */
  note: string;
  /** RFC 3339. The handler stamps it so the answer it returns names the row. */
  created_at: string;
}

/**
 * Append one vote. Throws when ClickHouse refuses the insert: the person asked
 * for the vote to be recorded, so a failure is theirs to see, not a gap to
 * log and hide.
 */
export async function recordReplyFeedback(
  row: ReplyFeedbackRow,
): Promise<void> {
  await chInsert(REPLY_FEEDBACK_TABLE, [
    row as unknown as Record<string, unknown>,
  ]);
}

/** One person's current verdict on one run: the newest of their votes. */
export interface ReplyFeedbackVote {
  runId: string;
  conversationId: string;
  messageId: string;
  userId: string;
  verdict: ReplyFeedbackVerdict;
  /** Null when the newest vote carried no note. */
  note: string | null;
  /** ClickHouse DateTime64 text: when the newest vote was cast. */
  votedAt: string;
}

export interface ReadReplyFeedbackArgs {
  /** Trailing window in days: votes newer than now() - windowDays. */
  windowDays: number;
  /** Keep only runs whose current verdict is this one. */
  verdict?: ReplyFeedbackVerdict;
  /** Keep only these runs (`arun_...`). */
  runIds?: readonly string[];
  /** At most this many rows, newest first. */
  limit: number;
}

/** Raw JSON shape. The aliases differ from the column names on purpose. */
interface RawReplyFeedbackVote {
  run_public_id: string;
  voter_id: string;
  latest_conversation_id: string;
  latest_message_id: string;
  latest_verdict: string;
  latest_note: string;
  latest_at: string;
}

/**
 * The current verdict per (person, run) in the active workspace, newest first.
 *
 * A vote is a row and a change of mind is a second row, so the current verdict
 * is argMax over created_at inside each (run_public_id, user_id) group. The
 * aggregates carry `latest_` aliases rather than their column's own name, so
 * the HAVING on the verdict reads the aggregate and never the raw column.
 *
 * The replay set reads it with `verdict: "wrong"` to find the recorded turns a
 * person said were wrong, then opens each run through get_run.
 */
export async function readReplyFeedback(
  args: ReadReplyFeedbackArgs,
): Promise<ReplyFeedbackVote[]> {
  const params: Record<string, unknown> = {
    windowDays: Math.max(0, Math.floor(args.windowDays)),
    limit: Math.max(1, Math.floor(args.limit)),
  };
  const filters: string[] = [];
  if (args.runIds !== undefined) {
    if (args.runIds.length === 0) return [];
    filters.push("AND run_public_id IN {runIds:Array(String)}");
    params.runIds = [...args.runIds];
  }
  const having: string[] = [];
  if (args.verdict !== undefined) {
    having.push("HAVING latest_verdict = {verdict:String}");
    params.verdict = args.verdict;
  }

  const res = await chSelect<RawReplyFeedbackVote>({
    query: `
      SELECT
        run_public_id                                  AS run_public_id,
        toString(user_id)                              AS voter_id,
        toString(argMax(conversation_id, created_at))  AS latest_conversation_id,
        toString(argMax(message_id, created_at))       AS latest_message_id,
        argMax(verdict, created_at)                    AS latest_verdict,
        argMax(note, created_at)                       AS latest_note,
        toString(max(created_at))                      AS latest_at
      FROM ${REPLY_FEEDBACK_TABLE}
      WHERE org_id = {orgId:UUID}
        AND workspace_id = {workspaceId:UUID}
        AND created_at >= now() - toIntervalDay({windowDays:UInt32})
        ${filters.join("\n        ")}
      GROUP BY run_public_id, user_id
      ${having.join("\n      ")}
      ORDER BY latest_at DESC
      LIMIT {limit:UInt32}
    `,
    params,
  });

  return res.data.map((r) => ({
    runId: r.run_public_id,
    conversationId: r.latest_conversation_id,
    messageId: r.latest_message_id,
    userId: r.voter_id,
    verdict: r.latest_verdict as ReplyFeedbackVerdict,
    note: r.latest_note === "" ? null : r.latest_note,
    votedAt: r.latest_at,
  }));
}
