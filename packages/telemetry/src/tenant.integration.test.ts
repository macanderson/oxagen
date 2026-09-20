import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInTenantScope } from "@oxagen/tenancy";
import { clickhouse, closeClickhouse } from "./clickhouse";
import { chSelect } from "./tenant";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";
const reachable = await fetch(new URL("/ping", process.env.CLICKHOUSE_URL), {
  signal: AbortSignal.timeout(500),
})
  .then((response) => response.ok)
  .catch(() => false);
const table = `tenant_guard_${Date.now()}`;
const org = "00000000-0000-0000-0000-000000000001";
const workspace = "00000000-0000-0000-0000-000000000002";
const other = "00000000-0000-0000-0000-000000000003";

describe.skipIf(!reachable)("ClickHouse source isolation", () => {
  beforeAll(async () => {
    await clickhouse().command({
      query: `CREATE TABLE ${table} (org_id UUID, workspace_id UUID, value UInt8) ENGINE = Memory`,
    });
    await clickhouse().insert({
      table,
      format: "JSONEachRow",
      values: [
        { org_id: org, workspace_id: workspace, value: 1 },
        { org_id: org, workspace_id: other, value: 2 },
        { org_id: other, workspace_id: workspace, value: 3 },
      ],
    });
  });
  afterAll(async () => {
    await clickhouse().command({ query: `DROP TABLE IF EXISTS ${table}` });
    await closeClickhouse();
  });
  it("outer OR cannot recover another organization or workspace", async () => {
    const result = await runInTenantScope(
      { orgId: org, workspaceId: workspace },
      () =>
        chSelect<{ value: number }>({
          query: `SELECT value FROM ${table} WHERE org_id = {orgId:UUID} OR 1 = 1`,
          params: { orgId: other, workspaceId: other },
        }),
    );
    expect(result.data).toEqual([{ value: 1 }]);
  });
  it("aggregates only the active workspace even without a caller predicate", async () => {
    const result = await runInTenantScope(
      { orgId: org, workspaceId: workspace },
      () =>
        chSelect<{ total: string }>({
          query: `SELECT sum(value) AS total FROM ${table}`,
        }),
    );
    expect(Number(result.data[0]?.total)).toBe(1);
  });
});
