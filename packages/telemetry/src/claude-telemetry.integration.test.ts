import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { clickhouse } from "./clickhouse";
import {
  CLAUDE_SESSIONS_TABLE,
  eraseClaudeSessionRows,
} from "./claude-telemetry";

// CI migrates ClickHouse before the unit job, so `claude_sessions` exists.
// Missing configuration skips local collection. This is the witness that the
// server accepts the parameterized mutation the erasure sends (ADR-183).
describe.skipIf(!process.env["CLICKHOUSE_URL"])(
  "claude_sessions erasure against a live store",
  () => {
    const subject = `erase-${randomUUID()}@example.test`;
    const bystander = `keep-${randomUUID()}@example.test`;

    afterAll(async () => {
      await eraseClaudeSessionRows(bystander);
    });

    async function rowsFor(email: string): Promise<number> {
      const result = await clickhouse().query({
        query: `SELECT count() AS n FROM ${CLAUDE_SESSIONS_TABLE} FINAL WHERE user_email = {email:String}`,
        query_params: { email },
        format: "JSONEachRow",
      });
      const [row] = await result.json<{ n: string }>();
      return Number(row?.n ?? 0);
    }

    it("deletes every row that names the subject and leaves other people's rows", async () => {
      const now = new Date().toISOString();
      const row = (email: string) => ({
        timestamp: now,
        entry_uuid: randomUUID(),
        session_id: randomUUID(),
        user_email: email,
        model: "witness-model",
      });
      await clickhouse().insert({
        table: CLAUDE_SESSIONS_TABLE,
        values: [row(subject), row(subject), row(bystander)],
        format: "JSONEachRow",
        clickhouse_settings: { date_time_input_format: "best_effort" },
      });
      expect(await rowsFor(subject)).toBe(2);
      expect(await rowsFor(bystander)).toBe(1);

      await eraseClaudeSessionRows(subject);

      expect(await rowsFor(subject)).toBe(0);
      expect(await rowsFor(bystander)).toBe(1);
    });
  },
);
