import { randomUUID } from "node:crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readRunCommandRefFrames } from "./run-command-refs";

// The frame read behind get_run_issues and the Release row runs against a
// real `tacho_events`. CI migrates ClickHouse before the unit job, so the SQL
// itself is under test there, the way run-work.clickhouse.test.ts tests the
// other work reads. A machine without a reachable ClickHouse skips.
const url = process.env["CLICKHOUSE_URL"];
const reachable = url
  ? await fetch(new URL("/ping", url), { signal: AbortSignal.timeout(500) })
      .then((response) => response.ok)
      .catch(() => false)
  : false;

const scope = { orgId: randomUUID(), workspaceId: randomUUID() };
const session = randomUUID();

/** One frame, every column not named here left at its default. */
function frame(
  seq: number,
  chainVerified: boolean,
  columns: Record<string, unknown>,
) {
  const ts = `2026-09-26 10:00:${String(seq).padStart(2, "0")}.000`;
  return {
    org_id: scope.orgId,
    workspace_id: scope.workspaceId,
    session_uuid: session,
    root_session_uuid: session,
    seq,
    ts,
    received_at: ts,
    chain_verified: chainVerified,
    cwd: "/work/app",
    ...columns,
  };
}

// The chain breaks after seq 1. ADR-171 reads every accepted frame.
const FRAMES = [
  frame(0, true, { kind: "command", tool_target: "gh issue view 482" }),
  // The tool_call frame for the same command is not an effect frame.
  frame(1, true, { kind: "tool_call", tool_target: "gh issue view 482" }),
  frame(5, false, {
    kind: "command",
    tool_target: "gh release create v4.11.0 --draft",
    worktree_path: "/work/app-wt",
  }),
  frame(6, false, { kind: "command", tool_target: "git status" }),
  frame(7, false, {
    kind: "network",
    tool_target: "api.githubcopilot.com",
    attrs: {
      "issue.repository": "acme/app",
      "issue.number": "44",
      "issue.url": "https://github.com/acme/app/issues/44",
      "issue.action": "created",
    },
  }),
];

const read = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);

describe.skipIf(!reachable)("the command ref frame read on ClickHouse", () => {
  beforeAll(async () => {
    // Imported here, not at the top: the tenancy-seam lint rule (OXA-1515)
    // forbids a static `clickhouse` import outside @oxagen/telemetry.
    const { clickhouse } = await import("@oxagen/telemetry");
    await clickhouse().insert({
      table: "tacho_events",
      format: "JSONEachRow",
      values: FRAMES,
    });
  });
  afterAll(async () => {
    const { closeClickhouse } = await import("@oxagen/telemetry");
    await closeClickhouse();
  });

  it("reads the effect frames that name an issue or a release, in frame order, past a chain break", async () => {
    const rows = await read(() => readRunCommandRefFrames(session));
    expect(
      rows.map((row) => ({
        seq: String(row.seq),
        command: row.command,
        path: row.path,
        issue_number: row.issue_number,
        issue_action: row.issue_action,
      })),
    ).toEqual([
      {
        seq: "0",
        command: "gh issue view 482",
        path: "/work/app",
        issue_number: "",
        issue_action: "",
      },
      {
        seq: "5",
        command: "gh release create v4.11.0 --draft",
        path: "/work/app-wt",
        issue_number: "",
        issue_action: "",
      },
      {
        seq: "7",
        command: "api.githubcopilot.com",
        path: "/work/app",
        issue_number: "44",
        issue_action: "created",
      },
    ]);
    expect(rows[0]?.observed_at).toBe("2026-09-26 10:00:00.000");
  });
});
