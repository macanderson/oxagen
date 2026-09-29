// findings-chselect.test.ts: each findings read that goes through chSelect
// sends a query the tenant fence accepts. The other findings tests replace
// chSelect with a stub, so none of them reaches the fence. A `{from:...}`
// parameter once read as a second FROM and refused all three reads (#2972).
import { scopeSelectSource } from "@oxagen/telemetry";
import { describe, expect, it } from "vitest";
import { PROMPTS_QUERY } from "./findings-prompts";
import { COMPACTIONS_QUERY, FIRST_PROMPTS_QUERY } from "./findings-run-facts";

describe("findings reads through chSelect", () => {
  it.each([
    ["PROMPTS_QUERY", PROMPTS_QUERY],
    ["FIRST_PROMPTS_QUERY", FIRST_PROMPTS_QUERY],
    ["COMPACTIONS_QUERY", COMPACTIONS_QUERY],
  ])("%s passes the tenant fence", (_name, query) => {
    const scoped = scopeSelectSource(query);
    expect(scoped).toContain(
      "FROM (SELECT * FROM tacho_events FINAL WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}) AS tacho_events",
    );
    // The caller's parameters reach ClickHouse unchanged.
    expect(scoped).toContain("{from:DateTime64(3)}");
  });
});
