/**
 * record-token-usage.ts — the one place a gateway-metered model call is
 * recorded: the `token_usage` frame in ClickHouse and, in the same breath,
 * the spend-budget counter in Postgres (`@oxagen/billing` recordSpend,
 * Mission Control spec §12.5, ADR-060 §5).
 *
 * The two writes are independent on purpose. The counter is what the budget
 * gate reads, so a ClickHouse stall must not keep it from moving (#2820: a
 * stalled store charged the customer while the ceiling read zero); a Postgres
 * failure must not lose the frame either. Each failure is logged and
 * swallowed; a caller that wraps this in its own try/catch keeps that guard
 * for the prompt hash it computes first.
 */
import pino from "pino";
import { insertTokenUsage, type TokenUsageRow } from "@oxagen/telemetry";
import { recordSpend } from "@oxagen/billing";

const logger = pino({
  name: "ai.record-token-usage",
  level: process.env["LOG_LEVEL"] ?? "info",
});

export async function recordTokenUsage(
  rows: readonly TokenUsageRow[],
): Promise<void> {
  const [frame, counter] = await Promise.allSettled([
    insertTokenUsage(rows),
    Promise.all(
      rows.map((r) =>
        recordSpend({
          orgId: r.org_id,
          workspaceId: r.workspace_id,
          at: new Date(r.created_at),
          micros: BigInt(Math.max(0, Math.round(r.cost_usd_micros))),
        }),
      ),
    ),
  ]);
  if (frame.status === "rejected")
    logger.error({ err: frame.reason }, "token_usage frame write failed");
  if (counter.status === "rejected")
    logger.error(
      { err: counter.reason },
      "spend counter write failed; the budget gate lags this call",
    );
}
