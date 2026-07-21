import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitStatements } from "./migrate";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(here, "migrations", "0026_stella_operational_events.sql"),
  "utf8",
);
const databaseName = `stella_operational_it_${randomBytes(8).toString("hex")}`;
const tableName = `${databaseName}.stella_operational_events`;

let isClickhouseAvailable = false;
let isDatabaseCreated = false;
let showCreateStatement = "";

beforeAll(async () => {
  const { clickhouse } = await import("./clickhouse");
  try {
    const ping = await clickhouse().ping();
    if (!ping.success) return;
  } catch (error) {
    console.error(
      "stella-operational-idempotency.integration: local ClickHouse unreachable; skipping:",
      error instanceof Error ? error.message : error,
    );
    return;
  }

  const statements = splitStatements(migrationSql);
  if (statements.length !== 1) {
    throw new Error(
      `expected one Stella operational migration statement, got ${statements.length}`,
    );
  }
  const createStatement = statements[0]?.replace(
    "stella_operational_events",
    tableName,
  );
  if (!createStatement?.includes(tableName)) {
    throw new Error("could not qualify the Stella operational migration table");
  }

  await clickhouse().command({
    query: `CREATE DATABASE \`${databaseName}\``,
  });
  isDatabaseCreated = true;
  await clickhouse().command({ query: createStatement });

  const showCreate = await clickhouse().query({
    query: `SHOW CREATE TABLE ${tableName}`,
    format: "JSONEachRow",
  });
  const rows = await showCreate.json<{ statement: string }>();
  showCreateStatement = rows[0]?.statement ?? "";
  isClickhouseAvailable = true;
}, 30_000);

afterAll(async () => {
  const { clickhouse, closeClickhouse } = await import("./clickhouse");
  if (isDatabaseCreated) {
    await clickhouse().command({
      query: `DROP DATABASE \`${databaseName}\``,
    });
  }
  await closeClickhouse();
});

describe("stella_operational_events retry idempotency", () => {
  it("executes the current migration DDL with the required engine and keys", (context) => {
    if (!isClickhouseAvailable) return context.skip();

    expect(showCreateStatement).toContain(
      "ENGINE = ReplacingMergeTree(received_at)",
    );
    expect(showCreateStatement).toContain("PARTITION BY toYYYYMM(received_at)");
    expect(showCreateStatement).toContain(
      "ORDER BY (org_id, workspace_id, event_id)",
    );
  });

  it("collapses duplicate event_id retries under FINAL", async (context) => {
    if (!isClickhouseAvailable) return context.skip();

    const { clickhouse } = await import("./clickhouse");
    const client = clickhouse();
    const orgId = randomUUID();
    const workspaceId = randomUUID();
    const eventId = `evt_${randomBytes(32).toString("hex")}`;
    // Exercise the sharp edge created by monthly partitioning: exact FINAL
    // reads must collapse a retry even when the two server receipt timestamps
    // straddle a month boundary.
    const firstReceivedAt = new Date("2026-01-31T23:59:59.000Z");
    const retryReceivedAt = new Date("2026-02-01T00:00:01.000Z");
    const baseRow = {
      org_id: orgId,
      workspace_id: workspaceId,
      schema: "stella.operational.v1",
      event_class: "execution_rollup",
      event_id: eventId,
      enrollment_id: "integration-test",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-5",
      outcome: "completed",
      duration_ms: 1_250,
      input_tokens: 1_000,
      output_tokens: 250,
      cost_microusd: 4_200,
      tool_call_count: 3,
      changed_file_count: 2,
      produced_output: true,
    };

    await client.insert({
      table: tableName,
      values: [{ ...baseRow, received_at: firstReceivedAt.toISOString() }],
      format: "JSONEachRow",
    });
    await client.insert({
      table: tableName,
      values: [
        {
          ...baseRow,
          received_at: retryReceivedAt.toISOString(),
        },
      ],
      format: "JSONEachRow",
    });

    const result = await client.query({
      query: `
          SELECT count() AS count
          FROM ${tableName} FINAL
          WHERE org_id = {orgId:UUID}
            AND workspace_id = {workspaceId:UUID}
            AND event_id = {eventId:String}
        `,
      query_params: { orgId, workspaceId, eventId },
      clickhouse_settings: {
        do_not_merge_across_partitions_select_final: 0,
      },
      format: "JSONEachRow",
    });
    const rows = await result.json<{ count: string }>();
    expect(Number(rows[0]?.count ?? -1)).toBe(1);
  }, 30_000);
});
