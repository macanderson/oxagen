import { randomUUID } from "node:crypto";
import { runInTenantScope } from "@oxagen/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readSessionConfig,
  readSessionTitle,
  readWorkContexts,
  readWorkDiffs,
  readWorkPrLinks,
  readWorkSubagents,
} from "./run-work";

// The six reads run against a real `tacho_events`. CI migrates ClickHouse
// before the unit job, so the SQL itself is under test there: the alias that
// failed every get_run_work call in production (code 184, 2026-09-24) passed
// every mocked test. A machine without a reachable ClickHouse skips.
const url = process.env["CLICKHOUSE_URL"];
const reachable = url
  ? await fetch(new URL("/ping", url), { signal: AbortSignal.timeout(500) })
      .then((response) => response.ok)
      .catch(() => false)
  : false;

const scope = { orgId: randomUUID(), workspaceId: randomUUID() };
const session = randomUUID();
const REPOSITORY = "https://github.com/acme/app";
const PR = "https://github.com/acme/app/pull/41";

/** One frame, every column not named here left at its default. */
function frame(
  seq: number,
  chainVerified: boolean,
  columns: Record<string, unknown>,
) {
  const ts = `2026-09-24 10:00:${String(seq).padStart(2, "0")}.000`;
  return {
    org_id: scope.orgId,
    workspace_id: scope.workspaceId,
    session_uuid: session,
    root_session_uuid: session,
    seq,
    ts,
    received_at: ts,
    chain_verified: chainVerified,
    ...columns,
  };
}

// The chain holds for seq 0 and 1, then breaks: 2 to 9 never arrive, and
// ingest stamps every later frame unverified. ADR-171 reads them all.
const FRAMES = [
  frame(0, true, {
    kind: "session_start",
    cwd: "/work/app",
    git_branch: "main",
    git_remote_digest: "sha256:remote",
    git_head_sha: "a".repeat(40),
    effort: "high",
    attrs: { repository_url: REPOSITORY },
  }),
  frame(1, true, {
    kind: "subagent_start",
    attrs: { "hook.agent_id": "agent-before", "hook.agent_type": "Explore" },
  }),
  frame(10, false, {
    kind: "oxagen:pr_link",
    attrs: { pr_url: PR, pr_number: "41", pr_repository: "acme/app" },
  }),
  frame(11, false, {
    kind: "oxagen:pr_link",
    attrs: { pr_url: PR, pr_number: "41", pr_repository: "acme/app" },
  }),
  frame(12, false, {
    kind: "oxagen:session_title",
    body: JSON.stringify({ session_title: "Fix the run page" }),
  }),
  frame(13, false, {
    kind: "oxagen:worktree_reconciled",
    worktree_path: "/work/app-wt",
    git_branch: "fix/run",
    git_remote_digest: "sha256:remote",
    content_digest: "sha256:diff",
    bytes_ref: "blob",
    attrs: {
      repository_url: REPOSITORY,
      diff_head_sha: "b".repeat(40),
      diff_base_sha: "c".repeat(40),
      diff_complete: "true",
    },
  }),
  frame(14, false, {
    kind: "subagent_start",
    attrs: { "hook.agent_id": "agent-after", "hook.agent_type": "Plan" },
  }),
  frame(15, false, {
    kind: "session_config",
    effort_level_setting: "max",
    always_thinking_enabled: true,
  }),
];

const read = <T>(fn: () => Promise<T>) => runInTenantScope(scope, fn);

describe.skipIf(!reachable)("run work reads on ClickHouse", () => {
  beforeAll(async () => {
    // Imported here, not at the top: the tenancy-seam lint rule (OXA-1515)
    // forbids a static `clickhouse` import outside @oxagen/telemetry, and
    // seeding a fixture needs the raw client. run.turns.get.integration.test.ts
    // seeds the same table the same way.
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

  it("reads each PR link once, at its first frame, past a chain break", async () => {
    const links = await read(() => readWorkPrLinks(session));
    expect(
      links.map((row) => ({ ...row, first_seq: String(row.first_seq) })),
    ).toEqual([
      {
        url: PR,
        number: "41",
        repository: "acme/app",
        first_seq: "10",
        first_ts: "2026-09-24 10:00:10.000",
      },
    ]);
  });

  it("reads the checkouts from before and after the break", async () => {
    const contexts = await read(() => readWorkContexts(session));
    expect(contexts.map(({ path, branch }) => [path, branch])).toEqual([
      ["/work/app", "main"],
      ["/work/app-wt", "fix/run"],
    ]);
  });

  it("reads the subagents from before and after the break", async () => {
    const subagents = await read(() => readWorkSubagents(session));
    expect(subagents.map(({ id, type }) => [id, type])).toEqual([
      ["agent-before", "Explore"],
      ["agent-after", "Plan"],
    ]);
  });

  it("reads the captured diff with its observed time", async () => {
    const diffs = await read(() => readWorkDiffs(session));
    expect(
      diffs.map((row) => ({
        seq: String(row.seq),
        observed_at: row.observed_at,
        path: row.path,
        head: row.head,
      })),
    ).toEqual([
      {
        seq: "13",
        observed_at: "2026-09-24 10:00:13.000",
        path: "/work/app-wt",
        head: "b".repeat(40),
      },
    ]);
  });

  it("reads the title and the settings the session last recorded", async () => {
    await expect(read(() => readSessionTitle(session))).resolves.toBe(
      "Fix the run page",
    );
    await expect(read(() => readSessionConfig(session))).resolves.toEqual({
      effort: "max",
      thinking: true,
    });
  });
});
