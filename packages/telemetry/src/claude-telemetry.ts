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
 * The mutations on `claude_sessions` the server has not finished, by id, with
 * the reason each last failed (empty while none has). `system.mutations`
 * names each one by table, not by the address it deletes, so the address
 * never appears in this query.
 */
export const UNFINISHED_CLAUDE_SESSIONS_MUTATIONS_QUERY =
  "SELECT mutation_id, latest_fail_reason FROM system.mutations WHERE database = currentDatabase() AND table = {table:String} AND is_done = 0";

/**
 * How long an erase waits for its mutation (#4316): 60 reads, 15 seconds
 * apart. A mutation rewrites every part that holds a matching row, which can
 * take minutes on a large table. The server keeps running a mutation the
 * erase stopped waiting for.
 */
export const ERASE_CLAUDE_SESSIONS_POLL_MS = 15_000;
export const ERASE_CLAUDE_SESSIONS_POLLS = 60;
export const ERASE_CLAUDE_SESSIONS_WAIT_MS =
  ERASE_CLAUDE_SESSIONS_POLL_MS * ERASE_CLAUDE_SESSIONS_POLLS;

interface UnfinishedMutation {
  mutation_id: string;
  latest_fail_reason: string;
}

async function unfinishedMutations(): Promise<UnfinishedMutation[]> {
  const result = await clickhouse().query({
    query: UNFINISHED_CLAUDE_SESSIONS_MUTATIONS_QUERY,
    query_params: { table: CLAUDE_SESSIONS_TABLE },
    format: "JSONEachRow",
  });
  return result.json<UnfinishedMutation>();
}

/**
 * Queue the mutation that deletes every `claude_sessions` row whose
 * `user_email` is `email`, and return its id while it runs. An empty list
 * means it finished before this returned. Throws when ClickHouse refuses. An
 * empty address matches the rows written after the backfill stopped sending
 * one, so it is refused.
 *
 * The statement returns once the mutation is queued (`mutations_sync = 0`).
 * Waiting inside it held one request open for the whole mutation, and the
 * shared client gives up on a request after 30 seconds, so an erase over a
 * large table failed every time it was tried (#4316). The id is the one
 * unfinished mutation on the table that was not there before the statement,
 * so a mutation that was already running, such as an earlier erase that
 * keeps failing, is never mistaken for this one.
 */
export async function submitClaudeSessionsErase(
  email: string,
): Promise<string[]> {
  if (email.trim().length === 0) {
    throw new Error(
      "the claude_sessions erase needs a non-empty email address",
    );
  }
  const before = new Set(
    (await unfinishedMutations()).map((mutation) => mutation.mutation_id),
  );
  await clickhouse().command({
    query: ERASE_CLAUDE_SESSIONS_QUERY,
    query_params: { email },
    // 0: return once the mutation is queued. The caller waits for it.
    clickhouse_settings: { mutations_sync: "0" },
  });
  return (await unfinishedMutations())
    .map((mutation) => mutation.mutation_id)
    .filter((id) => !before.has(id));
}

/**
 * How many of the erase's mutations `ids` the server has not finished. One
 * no longer listed as unfinished has finished. Throws as soon as one of them
 * has failed, naming its id and not its reason, since the reason can quote
 * the statement.
 */
export async function claudeSessionsEraseRemaining(
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const wanted = new Set(ids);
  const running = (await unfinishedMutations()).filter((mutation) =>
    wanted.has(mutation.mutation_id),
  );
  const failing = running.find(
    (mutation) => mutation.latest_fail_reason !== "",
  );
  if (failing !== undefined) {
    throw new Error(
      `the claude_sessions erase failed: ClickHouse reports mutation ${failing.mutation_id} failing. Read its latest_fail_reason in system.mutations.`,
    );
  }
  return running.length;
}

/** The clock and the wait, replaceable in tests. */
export interface EraseWaitOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
}

/**
 * Delete every `claude_sessions` row whose `user_email` is `email`, and wait
 * in this process for the mutation to finish: `submitClaudeSessionsErase`,
 * then `claudeSessionsEraseRemaining` until it answers 0. Throws when
 * ClickHouse refuses, when the mutation fails, or when it has not finished
 * within `ERASE_CLAUDE_SESSIONS_WAIT_MS`, so a caller never reports an
 * erasure that did not happen.
 *
 * A durable function calls the two halves as separate steps instead
 * (`privacy.erasure.execute.ts`), so no single request waits for the whole
 * mutation and a retried wait never queues the mutation again.
 */
export async function eraseClaudeSessionRows(
  email: string,
  options: EraseWaitOptions = {},
): Promise<void> {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? ERASE_CLAUDE_SESSIONS_WAIT_MS;
  const ids = await submitClaudeSessionsErase(email);
  const deadline = now() + waitMs;
  let interval = 1_000;
  for (;;) {
    const remaining = await claudeSessionsEraseRemaining(ids);
    if (remaining === 0) return;
    if (now() >= deadline) {
      throw new Error(
        `the claude_sessions erase did not finish within ${String(Math.round(waitMs / 1000))} seconds. The server keeps running it.`,
      );
    }
    await sleep(interval);
    interval = Math.min(interval * 2, ERASE_CLAUDE_SESSIONS_POLL_MS);
  }
}
