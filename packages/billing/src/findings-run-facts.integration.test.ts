// findings-run-facts.integration.test.ts — the first-prompt read against a
// live store. CI migrates ClickHouse before the unit job, so `tacho_events`
// exists with every migration applied. Missing configuration skips local
// collection.
//
// This is the witness that FIRST_PROMPTS_QUERY passes the tenant fence and
// runs on the server, and that it finds who sent a run's first prompt on
// whichever frame carries it: the `turn_start` a harness adapter wrote it on
// (Codex), or the transcript's `oxagen:message` copy of the prompt (Claude
// Code).
import { randomUUID } from "node:crypto";
import { chInsert } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import { describe, expect, it } from "vitest";
import { readFirstPrompts } from "./findings-run-facts";

const digest = (char: string) => `sha256:${char.repeat(64)}`;

interface PromptFrame {
  seq: number;
  /** Milliseconds after the run's start. */
  at: number;
  kind: "turn_start" | "oxagen:message";
  prompt_digest: string;
  prompt_source?: string;
  prompt_origin?: string;
  command_name?: string;
}

/** One `tacho_events` row on `root`'s own chain. */
function row(root: string, start: number, frame: PromptFrame) {
  return {
    session_uuid: root,
    root_session_uuid: root,
    seq: frame.seq,
    event_id: `evt_${root}_${frame.seq}`,
    event_id_idem: `evt_${root}_${frame.seq}`,
    ts: new Date(start + frame.at).toISOString(),
    kind: frame.kind,
    prompt_digest: frame.prompt_digest,
    prompt_source: frame.prompt_source ?? "",
    prompt_origin: frame.prompt_origin ?? "",
    command_name: frame.command_name ?? "",
    received_at: new Date().toISOString(),
  };
}

describe.skipIf(!process.env["CLICKHOUSE_URL"])(
  "the first-prompt read against a live store",
  () => {
    it("reads the sender off the turn_start, or off the transcript copy of its prompt", async () => {
      const scope = { orgId: randomUUID(), workspaceId: randomUUID() };
      const start = Date.now() - 60_000;
      const claudeCode = randomUUID();
      const codex = randomUUID();
      const silent = randomUUID();
      const adapterFirst = randomUUID();
      const frames: Record<string, PromptFrame[]> = {
        // Claude Code: the hook's turn_start names no sender, and the
        // transcript copy of the same prompt does. A meta record before it
        // names another sender and another digest, and the second prompt's
        // copy is queued. Neither is the first prompt's.
        [claudeCode]: [
          {
            seq: 0,
            at: 0,
            kind: "oxagen:message",
            prompt_digest: digest("a"),
            prompt_source: "system",
          },
          { seq: 1, at: 1_000, kind: "turn_start", prompt_digest: digest("b") },
          {
            seq: 2,
            at: 1_050,
            kind: "oxagen:message",
            prompt_digest: digest("b"),
            prompt_source: "typed",
            prompt_origin: '{"kind":"human"}',
          },
          { seq: 5, at: 9_000, kind: "turn_start", prompt_digest: digest("c") },
          {
            seq: 6,
            at: 9_050,
            kind: "oxagen:message",
            prompt_digest: digest("c"),
            prompt_source: "queued",
            prompt_origin: '{"kind":"human"}',
          },
        ],
        // Codex: the adapter wrote the sender on the turn_start itself.
        [codex]: [
          {
            seq: 1,
            at: 1_000,
            kind: "turn_start",
            prompt_digest: digest("d"),
            prompt_source: "sdk",
          },
        ],
        // A harness that records no sender: both fields read as null.
        [silent]: [
          { seq: 1, at: 1_000, kind: "turn_start", prompt_digest: digest("e") },
        ],
        // The turn_start's own pair wins over a message with the same text.
        [adapterFirst]: [
          {
            seq: 1,
            at: 1_000,
            kind: "turn_start",
            prompt_digest: digest("f"),
            prompt_source: "system",
            prompt_origin: '{"kind":"heartbeat"}',
          },
          {
            seq: 2,
            at: 1_050,
            kind: "oxagen:message",
            prompt_digest: digest("f"),
            prompt_source: "typed",
            prompt_origin: '{"kind":"human"}',
          },
        ],
      };
      await runInTenantScope(scope, () =>
        chInsert(
          "tacho_events",
          Object.entries(frames).flatMap(([root, list]) =>
            list.map((frame) => row(root, start, frame)),
          ),
        ),
      );

      const runs = new Map([
        ["run_claude_code", claudeCode],
        ["run_codex", codex],
        ["run_silent", silent],
        ["run_adapter_first", adapterFirst],
      ]);
      const out = await readFirstPrompts(
        scope,
        runs,
        new Date(start - 60_000),
      );

      expect(out.get("run_claude_code")).toMatchObject({
        digest: digest("b"),
        source: "typed",
        origin: '{"kind":"human"}',
        commandName: null,
      });
      expect(out.get("run_claude_code")?.at).toEqual(new Date(start + 1_000));
      expect(out.get("run_codex")).toMatchObject({
        digest: digest("d"),
        source: "sdk",
        origin: null,
      });
      expect(out.get("run_silent")).toMatchObject({
        digest: digest("e"),
        source: null,
        origin: null,
      });
      expect(out.get("run_adapter_first")).toMatchObject({
        digest: digest("f"),
        source: "system",
        origin: '{"kind":"heartbeat"}',
      });
    });
  },
);
