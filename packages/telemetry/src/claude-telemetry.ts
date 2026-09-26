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
 * The mutations on `claude_sessions` the server has not finished, and how
 * many of those last failed. `system.mutations` names each one by table, not
 * by the address it deletes, so the address never appears in this query.
 */
export const PENDING_CLAUDE_SESSIONS_MUTATIONS_QUERY =
  "SELECT count() AS pending, countIf(latest_fail_reason != '') AS failing FROM system.mutations WHERE database = currentDatabase() AND table = {table:String} AND is_done = 0";

/**
 * How long an erase waits for its mutation (#4316). A mutation rewrites every
 * part that holds a matching row, which can take minutes on a large table.
 * Past this, the erase throws and the caller's retry waits again. The server
 * keeps running the mutation meanwhile.
 */
export const ERASE_CLAUDE_SESSIONS_WAIT_MS = 15 * 60_000;
const POLL_FIRST_MS = 1_000;
const POLL_MAX_MS = 15_000;

/** The clock and the wait, replaceable in tests. */
export interface EraseWaitOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
}

/**
 * Delete every `claude_sessions` row whose `user_email` is `email`, and wait
 * for the mutation to finish. Throws when ClickHouse refuses, or when the
 * mutation has not finished within `ERASE_CLAUDE_SESSIONS_WAIT_MS`, so a
 * caller never reports an erasure that did not happen. An empty address
 * matches the rows written after the backfill stopped sending one, so it is
 * refused.
 *
 * The mutation is submitted without waiting, then `system.mutations` is read
 * until no mutation on the table is left. Waiting inside the statement
 * (`mutations_sync`) held one request open for the whole mutation, and the
 * shared client gives up on a request after 30 seconds, so an erase over a
 * large table failed every time it was tried (#4316). Each poll is one short
 * query. The wait covers every unfinished mutation on the table, this one
 * among them.
 */
export async function eraseClaudeSessionRows(
  email: string,
  options: EraseWaitOptions = {},
): Promise<void> {
  if (email.trim().length === 0) {
    throw new Error("eraseClaudeSessionRows needs a non-empty email address");
  }
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? ERASE_CLAUDE_SESSIONS_WAIT_MS;
  const client = clickhouse();
  await client.command({
    query: ERASE_CLAUDE_SESSIONS_QUERY,
    query_params: { email },
    // 0: return once the mutation is queued. The loop below waits for it.
    clickhouse_settings: { mutations_sync: "0" },
  });
  const deadline = now() + waitMs;
  let interval = POLL_FIRST_MS;
  for (;;) {
    const result = await client.query({
      query: PENDING_CLAUDE_SESSIONS_MUTATIONS_QUERY,
      query_params: { table: CLAUDE_SESSIONS_TABLE },
      format: "JSONEachRow",
    });
    const [row] = await result.json<{
      pending: string | number;
      failing: string | number;
    }>();
    const pending = Number(row?.pending ?? 0);
    if (pending === 0) return;
    if (now() >= deadline) {
      const failing = Number(row?.failing ?? 0);
      throw new Error(
        `the claude_sessions erase did not finish within ${String(Math.round(waitMs / 1000))} seconds: ${String(pending)} mutation(s) still running${failing > 0 ? `, ${String(failing)} of them failing` : ""}. The server keeps running it, and a retry waits for it again.`,
      );
    }
    await sleep(interval);
    interval = Math.min(interval * 2, POLL_MAX_MS);
  }
}
