// findings-result-use-query.test.ts: the result use read sends a query the
// tenant fence accepts. findings-result-use.test.ts replaces chSelect with a
// stub, so it never reaches the fence.
import { scopeSelectSource } from "@oxagen/telemetry";
import { describe, expect, it } from "vitest";
import { RESULT_STEPS_QUERY } from "./findings-result-use";

describe("the result use read through chSelect", () => {
  it("passes the tenant fence", () => {
    const scoped = scopeSelectSource(RESULT_STEPS_QUERY);
    expect(scoped).toContain(
      "FROM (SELECT * FROM tacho_events FINAL WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}) AS tacho_events",
    );
    // The caller's parameters reach ClickHouse unchanged.
    expect(scoped).toContain("{root:UUID}");
    expect(scoped).toContain("{chain:UUID}");
    expect(scoped).toContain("{from:DateTime64(3)}");
  });

  it("reads an llm_call only from the transcript, since a model proxy's body holds the whole request", () => {
    expect(RESULT_STEPS_QUERY).toContain(
      "(kind = 'llm_call' AND source = 'transcript')",
    );
  });
});
