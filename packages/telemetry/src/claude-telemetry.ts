/**
 * Erase one person's rows from ClickHouse `claude_sessions` (ADR-183).
 *
 * `claude_sessions` (migration 0007) keeps a Claude Code user's email address
 * in `user_email`, which is also the first column of its sort key. The table
 * keeps rows for two years (its TTL). A GDPR erasure request cannot wait two
 * years, so the privacy processor calls this with the address of the person
 * who asked, and every row that names the address is deleted.
 *
 * The table has no `org_id` or `workspace_id`, so the tenant seam in
 * `tenant.ts` does not apply. It lives in the platform store the migrations
 * create it in, which is the process client's database.
 */
import { clickhouse } from "./clickhouse";

/** The table and the column that holds the address, as 0007 creates them. */
export const CLAUDE_SESSIONS_TABLE = "claude_sessions";
export const CLAUDE_SESSIONS_EMAIL_COLUMN = "user_email";

/**
 * The statement that erases a person's rows.
 *
 * `ALTER TABLE ... DELETE` is a mutation that rewrites every part holding a
 * matching row, so the address is gone from disk when it finishes. A
 * lightweight `DELETE FROM` would only hide the rows until a later merge. The
 * address travels as a bound parameter, never as SQL text.
 */
export const ERASE_CLAUDE_SESSIONS_QUERY = `ALTER TABLE ${CLAUDE_SESSIONS_TABLE} DELETE WHERE ${CLAUDE_SESSIONS_EMAIL_COLUMN} = {email:String}`;

/**
 * Delete every `claude_sessions` row whose `user_email` is `email`, and wait
 * for the mutation to finish. Throws when ClickHouse refuses, so a caller
 * never reports an erasure that did not happen. An empty address matches the
 * rows written after the backfill stopped sending one, so it is refused.
 */
export async function eraseClaudeSessionRows(email: string): Promise<void> {
  if (email.trim().length === 0) {
    throw new Error("eraseClaudeSessionRows needs a non-empty email address");
  }
  await clickhouse().command({
    query: ERASE_CLAUDE_SESSIONS_QUERY,
    query_params: { email },
    // 2 waits for the mutation on every replica. On one node it is the same
    // wait as 1.
    clickhouse_settings: { mutations_sync: "2" },
  });
}
