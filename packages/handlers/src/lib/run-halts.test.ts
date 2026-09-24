import { schema } from "@oxagen/database";
import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it } from "vitest";
import { SCOPE } from "../run.test-support";
import { postgresReadRunHalts, runHaltsQuery, tachoPaused } from "./run-halts";

describe("runHaltsQuery (#4112)", () => {
  const db = drizzle.mock({ schema });
  const query = runHaltsQuery(db, SCOPE, ["tse_a", "tse_b"]).toSQL();

  it("reads the whole page in one statement, fenced to the tenant", () => {
    expect(query.sql.match(/\bselect\b/gi)).toHaveLength(1);
    expect(query.sql).toContain('from "tacho"."control_commands"');
    expect(query.sql).toMatch(/"org_id" = \$\d+/);
    expect(query.sql).toMatch(/"workspace_id" = \$\d+/);
    expect(query.params).toContain(SCOPE.orgId);
    expect(query.params).toContain(SCOPE.workspaceId);
    expect(query.params).toEqual(expect.arrayContaining(["tse_a", "tse_b"]));
  });

  it("counts only a pause or resume addressed to the run and applied by its host", () => {
    expect(query.params).toEqual(
      expect.arrayContaining(["run", "pause", "resume", "applied"]),
    );
    // A queued, failed or expired command, or a steer or cancel, changes
    // nothing about whether the run is paused.
    for (const word of ["queued", "failed", "expired", "steer", "cancel"])
      expect(query.params).not.toContain(word);
  });

  it("keeps the latest applied halt per run", () => {
    expect(query.sql).toContain(
      'distinct on ("tacho"."control_commands"."target_id")',
    );
    expect(query.sql).toMatch(
      /order by "tacho"\."control_commands"\."target_id", "tacho"\."control_commands"\."applied_at" desc nulls last, "tacho"\."control_commands"\."issued_at" desc/,
    );
  });

  it("reads nothing for an empty page", async () => {
    // No live wrapped run on the page: the read answers without a query, so
    // this runs with no database at all.
    await expect(postgresReadRunHalts(SCOPE, [])).resolves.toEqual(new Map());
  });
});

describe("tachoPaused", () => {
  it("is paused while the run is live and its last applied halt is a pause", () => {
    expect(tachoPaused("live", "pause")).toBe(true);
    expect(tachoPaused("live", "resume")).toBe(false);
    expect(tachoPaused("live", undefined)).toBe(false);
  });

  it("is never paused once the run has ended (negative)", () => {
    expect(tachoPaused("sealed", "pause")).toBe(false);
    expect(tachoPaused("halted", "pause")).toBe(false);
  });
});
