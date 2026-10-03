// findings-chselect.test.ts: each findings read that goes through chSelect
// sends a query the tenant fence accepts. The other findings tests replace
// chSelect with a stub, so none of them reaches the fence. A `{from:...}`
// parameter once read as a second FROM and refused all three reads (#2972).
import { scopeSelectSource, tachoEventsColumns } from "@oxagen/telemetry";
import { describe, expect, it } from "vitest";
import { PROMPTS_QUERY } from "./findings-prompts";
import { RESULT_STEPS_QUERY } from "./findings-result-use";
import { COMPACTIONS_QUERY, FIRST_PROMPTS_QUERY } from "./findings-run-facts";

/** Every name a query gives an expression with `AS`. */
function aliases(query: string): string[] {
  return [...query.matchAll(/\bAS\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]!);
}

/** The aliases in `query` that name a stored `tacho_events` column. */
function columnAliases(query: string): string[] {
  const columns = new Set(tachoEventsColumns().map((c) => c.name));
  return aliases(query).filter((name) => columns.has(name));
}

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

  // ClickHouse reads a name in WHERE as the SELECT alias before the column.
  // `toString(root_session_uuid) AS root_session_uuid` made the prompt read
  // compare a UUID with a String, which ClickHouse refuses (NO_COMMON_TYPE),
  // and the nightly findings pass failed on it from 2026-10-01 on (#5311).
  it.each([
    ["PROMPTS_QUERY", PROMPTS_QUERY],
    ["FIRST_PROMPTS_QUERY", FIRST_PROMPTS_QUERY],
    ["COMPACTIONS_QUERY", COMPACTIONS_QUERY],
    ["RESULT_STEPS_QUERY", RESULT_STEPS_QUERY],
  ])("%s gives no alias the name of a stored column", (_name, query) => {
    expect(columnAliases(query)).toEqual([]);
  });

  it("names the prompt read's root session `root`", () => {
    expect(aliases(PROMPTS_QUERY)).toEqual(["root", "at"]);
  });

  it("catches an alias that names a stored column", () => {
    expect(
      columnAliases(
        "SELECT toString(root_session_uuid) AS root_session_uuid FROM tacho_events WHERE session_uuid = root_session_uuid",
      ),
    ).toEqual(["root_session_uuid"]);
  });
});
