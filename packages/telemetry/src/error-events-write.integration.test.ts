// error-events-write.integration.test.ts
//
// Does a captured error actually become a row?
//
// WHY THIS EXISTS (#3698)
//
// `error_events` held zero rows in production while every server runtime
// called `captureError()` on every unhandled 500. Nothing in the suite had
// ever written one: `error-reporting.test.ts` mocks `./clickhouse`, so it
// proves what captureError() hands the boundary and stops there. The boundary
// itself — the JSONEachRow payload meeting a real `error_events` table — was
// the untested half, and it is the half that failed.
//
// A mocked client accepts any payload without complaint. It cannot tell a row
// ClickHouse stored from one it never received — because the table was absent
// ("Table oxagen.error_events does not exist", which is what production
// actually returned) or because a value would not parse — and captureError()
// swallows that rejection to a stderr line by design. Nor can it see the
// quieter half: ClickHouse runs with `input_format_skip_unknown_fields = 1`,
// so a column the table is missing is discarded and the row is stored anyway.
// So, like this package's other DDL-lifecycle suites, this runs against the
// real local ClickHouse (docker :8123) and skips cleanly when it is
// unreachable.
//
// `error-events-conformance.test.ts` beside this file is the gate that always
// runs: it compares the outgoing payload against the columns `migrations/`
// declares, with no database. This one proves the whole path end to end.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitStatements } from "./migrate";

const here = dirname(fileURLToPath(import.meta.url));
const databaseName = `error_events_it_${randomBytes(8).toString("hex")}`;

// Set BEFORE anything imports ./clickhouse: the client is a lazily-built
// singleton bound to CLICKHOUSE_DATABASE at first use, so pointing it at a
// throwaway database here is what keeps this suite from writing into the
// developer's own `oxagen` — which has no cheap delete, ClickHouse having only
// mutations.
process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE = databaseName;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

let isClickhouseAvailable = false;
let isDatabaseCreated = false;

interface ErrorRow {
  error_id: string;
  org_id: string;
  workspace_id: string;
  severity: string;
  source: string;
  error_class: string;
  message: string;
  stack: string;
  capability: string;
  request_id: string;
  fingerprint: string;
  execution_id: string;
  step_id: string | null;
}

/** Read the rows a marker message identifies, newest first. */
async function rowsMatching(marker: string): Promise<ErrorRow[]> {
  const { clickhouse } = await import("./clickhouse");
  const result = await clickhouse().query({
    query: `SELECT * FROM error_events WHERE message LIKE {marker:String} ORDER BY created_at DESC`,
    query_params: { marker: `%${marker}%` },
    format: "JSONEachRow",
  });
  return result.json<ErrorRow>();
}

beforeAll(async () => {
  // A bootstrap client with no database bound: the throwaway database does not
  // exist yet, and a connection scoped to a missing database is rejected.
  const { createClient } = await import("@clickhouse/client");
  const bootstrap = createClient({
    url: process.env.CLICKHOUSE_URL,
    username: process.env.CLICKHOUSE_USERNAME,
    password: process.env.CLICKHOUSE_PASSWORD,
  });

  try {
    const ping = await bootstrap.ping();
    if (!ping.success) {
      await bootstrap.close();
      return;
    }
    await bootstrap.command({
      query: `CREATE DATABASE \`${databaseName}\``,
    });
    isDatabaseCreated = true;
  } catch (error) {
    console.error(
      "error-events-write.integration: local ClickHouse unreachable; skipping:",
      error instanceof Error ? error.message : error,
    );
    await bootstrap.close().catch(() => undefined);
    return;
  }
  await bootstrap.close();

  // The table is built from the migration files rather than from a copy of the
  // DDL pasted here. A copy would drift from `migrations/` exactly the way
  // production drifted from it, and this suite would keep passing against a
  // table nothing deploys.
  const { clickhouse } = await import("./clickhouse");
  for (const file of [
    "0020_error_events.sql",
    "0022_error_events_execution_id.sql",
  ]) {
    const sql = readFileSync(join(here, "migrations", file), "utf8");
    for (const statement of splitStatements(sql)) {
      await clickhouse().command({ query: statement });
    }
  }

  isClickhouseAvailable = true;
  // The client can consume its full 30s transport timeout before rejecting a
  // ping, so leave the catch path enough hook budget to mark this skipped.
}, 60_000);

afterAll(async () => {
  const { clickhouse, closeClickhouse } = await import("./clickhouse");
  if (isDatabaseCreated) {
    await clickhouse()
      .command({ query: `DROP DATABASE IF EXISTS \`${databaseName}\`` })
      .catch(() => undefined);
  }
  await closeClickhouse();
});

describe("captureError writes to error_events", () => {
  it("lands a row for an unhandled error", async () => {
    if (!isClickhouseAvailable) {
      console.warn("local ClickHouse unavailable; skipping");
      return;
    }
    const { captureError } = await import("./error-reporting");
    const marker = `capture-probe-${randomUUID()}`;

    captureError({
      error: new TypeError(marker),
      source: "api",
      severity: "error",
      requestId: "req-probe",
      capability: "tacho.events.record",
    });

    // captureError is fire-and-forget: it returns before the insert resolves.
    // Poll rather than sleep a fixed span — the insert is one round-trip to a
    // local container and usually done in single-digit milliseconds.
    let rows: ErrorRow[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      rows = await rowsMatching(marker);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // The assertion #3698 is about: not "the insert resolved", but "the row is
    // readable back out of the table".
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.error_class).toBe("TypeError");
    expect(row?.message).toBe(marker);
    expect(row?.severity).toBe("error");
    expect(row?.source).toBe("api");
    expect(row?.request_id).toBe("req-probe");
    expect(row?.capability).toBe("tacho.events.record");
    expect(row?.stack).toContain("TypeError");
    expect(row?.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  }, 20_000);

  it("records an error captured before any tenant scope under the nil UUID", async () => {
    if (!isClickhouseAvailable) {
      console.warn("local ClickHouse unavailable; skipping");
      return;
    }
    const { captureError } = await import("./error-reporting");
    const marker = `prescope-probe-${randomUUID()}`;

    // No orgId / workspaceId / executionId — a boot-time or pre-auth crash,
    // which is the case that would abort the row if the sentinels were wrong.
    captureError({ error: new Error(marker), source: "api" });

    let rows: ErrorRow[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      rows = await rowsMatching(marker);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(rows).toHaveLength(1);
    expect(rows[0]?.org_id).toBe(NIL_UUID);
    expect(rows[0]?.workspace_id).toBe(NIL_UUID);
    expect(rows[0]?.execution_id).toBe(NIL_UUID);
    expect(rows[0]?.step_id).toBeNull();
  }, 20_000);

  it("stamps the execution scope so a debug trace can join on it", async () => {
    if (!isClickhouseAvailable) {
      console.warn("local ClickHouse unavailable; skipping");
      return;
    }
    const { captureError } = await import("./error-reporting");
    const marker = `execution-probe-${randomUUID()}`;
    const executionId = randomUUID();
    const stepId = randomUUID();

    captureError({
      error: new Error(marker),
      source: "runner",
      severity: "fatal",
      orgId: randomUUID(),
      executionId,
      stepId,
    });

    let rows: ErrorRow[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      rows = await rowsMatching(marker);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // 0022 added these two columns after 0020 shipped. A deployment that
    // recorded 0022 as applied without executing it has the table but not the
    // columns — and the writes still SUCCEED, because ClickHouse discards the
    // two unknown fields and stores the rest. Dropping the 0022 file from the
    // setup above turns exactly these assertions red and leaves "lands a row"
    // green, which is the whole argument for asserting what the columns hold
    // rather than that the write resolved.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.execution_id).toBe(executionId);
    expect(rows[0]?.step_id).toBe(stepId);
    expect(rows[0]?.severity).toBe("fatal");
    expect(rows[0]?.source).toBe("runner");
  }, 20_000);

  it("writes every source the row type allows", async () => {
    if (!isClickhouseAvailable) {
      console.warn("local ClickHouse unavailable; skipping");
      return;
    }
    const { captureError } = await import("./error-reporting");
    const marker = `sources-probe-${randomUUID()}`;
    // The DoD asks that every runtime calling captureError() is known to reach
    // the table, not just the one the fix was exercised against. The runtimes
    // differ only in this discriminator, so writing all five proves the column
    // accepts each one.
    const sources = ["api", "app", "mcp", "inngest", "runner"] as const;
    for (const source of sources) {
      captureError({ error: new Error(`${marker} ${source}`), source });
    }

    let rows: ErrorRow[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      rows = await rowsMatching(marker);
      if (rows.length === sources.length) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(rows.map((r) => r.source).sort()).toEqual([...sources].sort());
  }, 30_000);
});
