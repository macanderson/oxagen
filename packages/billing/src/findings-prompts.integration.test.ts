// findings-prompts.integration.test.ts — the prompt read against a live
// store. CI migrates ClickHouse before the unit job, so `tacho_events` exists
// with every migration applied. Missing configuration skips local collection.
//
// This is the witness that PROMPTS_QUERY runs on the server. The unit tests
// replace chSelect with a stub, and the query once aliased
// `toString(root_session_uuid)` as `root_session_uuid`. ClickHouse read the
// WHERE clause's `session_uuid = root_session_uuid` through that alias, as a
// UUID compared with a String, and refused it with NO_COMMON_TYPE. The
// nightly findings pass failed on it from 2026-10-01 on (#5311).
import { randomUUID } from "node:crypto";
import { chInsert } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import { describe, expect, it } from "vitest";
import { readPromptRows } from "./findings-prompts";

const digest = (char: string) => `sha256:${char.repeat(64)}`;

/** One `turn_start` row on `session`, under `root`, `at` ms after `start`. */
function turnStart(
  root: string,
  session: string,
  seq: number,
  at: number,
  over: { prompt_digest?: string; command_name?: string } = {},
) {
  const start = Date.now() - 60_000;
  return {
    session_uuid: session,
    root_session_uuid: root,
    seq,
    event_id: `evt_${session}_${seq}`,
    event_id_idem: `evt_${session}_${seq}`,
    ts: new Date(start + at).toISOString(),
    kind: "turn_start",
    prompt_digest: over.prompt_digest ?? digest("a"),
    prompt_length: 80,
    command_name: over.command_name ?? "",
    received_at: new Date().toISOString(),
  };
}

describe.skipIf(!process.env["CLICKHOUSE_URL"])(
  "the prompt read against a live store",
  () => {
    it("reads the operator prompts on each run's own chain", async () => {
      const scope = { orgId: randomUUID(), workspaceId: randomUUID() };
      const root = randomUUID();
      const child = randomUUID();
      await runInTenantScope(scope, () =>
        chInsert("tacho_events", [
          turnStart(root, root, 1, 1_000, { prompt_digest: digest("b") }),
          // A subagent's prompt sits on its own chain, not the run's.
          turnStart(root, child, 1, 2_000, { prompt_digest: digest("c") }),
          // A slash command is a template the harness keeps.
          turnStart(root, root, 2, 3_000, {
            prompt_digest: digest("d"),
            command_name: "review",
          }),
          // A turn with no prompt digest carries no prompt.
          turnStart(root, root, 3, 4_000, { prompt_digest: "" }),
        ]),
      );

      const rows = await readPromptRows(scope, {
        start: new Date(Date.now() - 10 * 60_000),
        end: new Date(Date.now() + 60_000),
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        root,
        prompt_digest: digest("b"),
      });
      expect(Number(rows[0]!.seq)).toBe(1);
    });
  },
);
