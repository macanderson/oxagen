import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clickhouse,
  insertDurableTokenUsage,
  stampTokenUsage,
  sumTokenUsage,
} from "./clickhouse";
import { readUsageBreakdown } from "./usage-analytics";

// CI migrates ClickHouse before the unit job. Missing configuration skips local collection.
describe.skipIf(!process.env["CLICKHOUSE_URL"])(
  "durable usage delivery identity",
  () => {
    it("collapses replayed deliveries while retaining distinct calls sharing one execution step", async () => {
      const orgId = randomUUID();
      const workspaceId = randomUUID();
      const step = randomUUID();
      const now = new Date().toISOString();
      const [row] = stampTokenUsage([
        {
          org_id: orgId,
          workspace_id: workspaceId,
          execution_step_id: step,
          model: "witness-model",
          provider: "anthropic",
          input_tokens: 10,
          output_tokens: 2,
          cached_tokens: 0,
          cost_usd_micros: 30,
          duration_ms: 1,
          surface: "api",
          prompt_hash: "witness",
          created_at: now,
        },
      ]);
      const id = randomUUID();
      await insertDurableTokenUsage(id, row!);
      await insertDurableTokenUsage(id, row!);
      await insertDurableTokenUsage(randomUUID(), row!);
      const result = await clickhouse().query({
        query:
          "SELECT count() AS calls, sum(cost_usd_micros) AS cost FROM metered_token_usage WHERE org_id = {org:UUID}",
        query_params: { org: orgId },
        format: "JSONEachRow",
      });
      const [totals] = await result.json<{ calls: string; cost: string }>();
      expect(Number(totals?.calls)).toBe(2);
      expect(Number(totals?.cost)).toBe(60);
      const start = new Date(Date.now() - 60_000);
      const end = new Date(Date.now() + 60_000);
      const breakdown = await readUsageBreakdown({
        orgId,
        workspaceId,
        start,
        end,
      });
      expect(breakdown.totals.executions).toBe(2);
      expect(breakdown.totals.costMicros).toBe(60);
      const rollup = await sumTokenUsage({
        orgId,
        periodStart: start,
        periodEnd: end,
      });
      expect(
        rollup.find((entry) => entry.metric === "tokens_input")?.quantity,
      ).toBe(20);
    });
  },
);
