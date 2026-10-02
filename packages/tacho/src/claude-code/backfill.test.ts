/**
 * The backfill driver against the mapping table in
 * `docs/specs/tacho/backfill.md` section 2 (#4028).
 *
 * The fixture under `fixtures/claude-code/backfill/mapping/` is synthetic: one
 * session with a record for every row of the table, a subagent its `Agent`
 * call spawned, and a subagent no call names. Every piece of text in it
 * carries `SENTINEL-TRANSCRIPT-TEXT`, so a test can tell where transcript text
 * went.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import {
  BACKFILL_NORMALIZER_VERSION,
  BackfillClock,
  type BackfillSubagent,
  firstTimedRecordOf,
  resultAgentIdsOf,
  sourceToolUseIdOf,
  TranscriptBackfill,
} from "./backfill";
import { SessionRecorder } from "./recorder";

const SESSION = "0b1f0000-0000-4000-8000-00000000b001";
const PROJECT = resolve(__dirname, "../../fixtures/claude-code/backfill/mapping");
const HOST = "thst_0123456789abcdef0123";
const SENTINEL = "SENTINEL-TRANSCRIPT-TEXT";

function recorderFor(sessionId: string, clock: BackfillClock): SessionRecorder {
  return new SessionRecorder({
    context: {
      agent: {
        agent_key: "acme.core.cc-laptop",
        fleet_id: "wrk_test",
        runtime: "claude-code",
        harness: "claude-code",
        wrapper_version: "2.1.1",
        host_enrollment_id: HOST,
      },
      now: clock.now,
    },
    harnessSessionId: sessionId,
    scope: HOST,
    backfill: { normalizerVersion: BACKFILL_NORMALIZER_VERSION },
  });
}

function linesOf(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line !== "");
}

interface Pass {
  events: TachoEvent[];
  bodies: FrameBody[];
  driver: TranscriptBackfill;
}

/** One pass over in-memory files, in the order the daemon reads them. */
function backfill(
  sessionId: string,
  parent: string[],
  subagentFiles: Record<string, string[]>,
  metas: Record<string, { agentType?: string; toolUseId?: string }> = {},
): Pass {
  const clock = new BackfillClock();
  const recorder = recorderFor(sessionId, clock);
  const resultAgentIds = new Map<string, string>();
  for (const line of parent) resultAgentIdsOf(line, resultAgentIds);
  const subagents: BackfillSubagent[] = Object.entries(subagentFiles).map(
    ([agentId, lines]) => {
      const meta = metas[agentId];
      const source = lines
        .map((line) => sourceToolUseIdOf(line))
        .find((id) => id !== undefined);
      return {
        agentId,
        ...(meta?.agentType !== undefined ? { agentType: meta.agentType } : {}),
        ...(meta?.toolUseId !== undefined
          ? { metaToolUseId: meta.toolUseId }
          : {}),
        ...(source !== undefined ? { sourceToolUseId: source } : {}),
      };
    },
  );
  const driver = new TranscriptBackfill({
    recorder,
    clock,
    subagents,
    resultAgentIds,
  });
  const events: TachoEvent[] = [];
  const bodies: FrameBody[] = [];
  const take = (sealed: TachoEvent[]) => {
    events.push(...sealed);
    bodies.push(...recorder.takeBodies());
  };
  const feedSubagent = (agentId: string) => {
    let offset = 0;
    for (const line of subagentFiles[agentId] ?? []) {
      take(driver.subagentLine(agentId, line, offset));
      offset += Buffer.byteLength(line) + 1;
    }
  };
  let offset = 0;
  for (const line of parent) {
    const { events: sealed, spawn } = driver.line(line, offset);
    take(sealed);
    for (const agentId of spawn) feedSubagent(agentId);
    offset += Buffer.byteLength(line) + 1;
  }
  const flushed = driver.finishParent();
  take(flushed.events);
  for (const agentId of flushed.spawn) feedSubagent(agentId);
  for (const agentId of driver.unspawned()) feedSubagent(agentId);
  take(driver.end());
  return { events, bodies, driver };
}

function fixturePass(): Pass {
  const dir = join(PROJECT, SESSION, "subagents");
  const files: Record<string, string[]> = {};
  for (const name of readdirSync(dir).sort()) {
    const match = /^agent-(.+)\.jsonl$/.exec(name);
    if (match) files[match[1] as string] = linesOf(join(dir, name));
  }
  const meta = JSON.parse(
    readFileSync(join(dir, "agent-sub0001.meta.json"), "utf8"),
  ) as { agentType?: string; toolUseId?: string };
  return backfill(
    SESSION,
    linesOf(join(PROJECT, `${SESSION}.jsonl`)),
    files,
    { sub0001: meta },
  );
}

function chains(events: TachoEvent[]): Map<string, TachoEvent[]> {
  const out = new Map<string, TachoEvent[]>();
  for (const event of events) {
    const chain = out.get(event.session_uuid) ?? [];
    chain.push(event);
    out.set(event.session_uuid, chain);
  }
  return out;
}

function ofKind(events: TachoEvent[], kind: string): TachoEvent[] {
  return events.filter((event) => event.kind === kind);
}

function body(event: TachoEvent | undefined): Record<string, unknown> {
  return (event?.body ?? {}) as Record<string, unknown>;
}

describe("a backfilled transcript", () => {
  it("seals byte-identical frames on a second pass over the same bytes", () => {
    const first = fixturePass();
    const second = fixturePass();
    expect(first.events.length).toBeGreaterThan(40);
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
    expect(
      JSON.stringify(
        second.bodies.map((b) => ({ ...b, bytes: Buffer.from(b.bytes).toString("base64") })),
      ),
    ).toBe(
      JSON.stringify(
        first.bodies.map((b) => ({ ...b, bytes: Buffer.from(b.bytes).toString("base64") })),
      ),
    );
    // The ids are derived, not random: the same frame names the same id.
    expect(second.events.map((e) => e.event_id)).toEqual(
      first.events.map((e) => e.event_id),
    );
  });

  it("seals one valid chain per session and subagent, each starting at seq 0", () => {
    const { events } = fixturePass();
    const byChain = chains(events);
    // The session, its spawned subagent, and the subagent no call names.
    expect(byChain.size).toBe(3);
    for (const chain of byChain.values()) {
      expect(chain[0]?.seq).toBe(0);
      expect(chain[0]?.kind).toBe("agent_start");
      expect(chain.map((e) => e.seq)).toEqual(chain.map((_, i) => i));
      expect(verifyChain(chain, { expectGenesis: true }).ok).toBe(true);
    }
  });

  it("marks every frame as a transcript-sourced backfill", () => {
    const { events } = fixturePass();
    for (const event of events) {
      expect(event.source).toBe("transcript");
      expect(event.fidelity).toBe("ambient");
      expect(event.hook_event_name).toBeUndefined();
      expect(event.attrs["oxagen.record_basis"]).toBe("backfill");
      expect(event.attrs["oxagen.git_basis"]).toBe("recorded");
      expect(event.event_id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  describe("the mapping table, row by row", () => {
    const { events } = fixturePass();
    const root = events.filter((e) => e.parent_session_uuid === undefined);
    const children = events.filter((e) => e.parent_session_uuid !== undefined);

    it("first timed record: agent_start with the recorded facts", () => {
      const start = root[0];
      expect(start?.kind).toBe("agent_start");
      expect(start?.ts).toBe("2026-08-10T10:00:00.000Z");
      expect(body(start)["session_start_source"]).toBe("backfill");
      expect(start?.context).toMatchObject({
        cwd: "/work/synthetic-repo",
        git_branch: "feature/synthetic",
        app_version: "2.1.281",
        entrypoint: "cli",
        session_kind: "interactive",
      });
      expect(start?.attrs["oxagen.synthesized_from"]).toBe("queue-operation");
      expect(start?.attrs["oxagen.backfill_normalizer"]).toBe(
        BACKFILL_NORMALIZER_VERSION,
      );
    });

    it("end of a finished file: agent_stop at the last timed record", () => {
      const stop = root.at(-1);
      expect(stop?.kind).toBe("agent_stop");
      expect(stop?.ts).toBe("2026-08-10T10:00:20.000Z");
      expect(body(stop)["session_end_reason"]).toBe("backfill_end_of_file");
      expect(body(stop)["session_outcome"]).toBe("unknown");
      // The `cost-state` totals ride the stop, as they do live.
      expect(body(stop)["total_cost_usd_micros"]).toBe(125_000);
      expect(stop?.attrs["oxagen.synthesized_from"]).toBe("end_of_file");
    });

    it("typed prompt: turn_start with the prompt id, then the message", () => {
      const starts = ofKind(root, "turn_start");
      expect(starts.map((e) => e.turn?.prompt_id)).toEqual([
        "p-0001",
        "p-0002",
        "p-0003",
      ]);
      expect(body(starts[0])["prompt_digest"]).toMatch(/^sha256:/);
      expect(starts[0]?.content?.digest).toMatch(/^sha256:/);
      // The transcript's copy of the prompt seals its facts without the text.
      const copies = ofKind(root, "oxagen:message").filter(
        (e) => e.attrs["oxagen.prompt_duplicate_of"] === "turn_start",
      );
      expect(copies).toHaveLength(3);
      for (const copy of copies) expect(copy.content).toBeUndefined();
      // A compaction summary is a user record, not a prompt.
      expect(starts).toHaveLength(3);
    });

    it("turn_duration closes the turn with its duration and stop reason", () => {
      const ends = ofKind(root, "turn_end");
      expect(ends).toHaveLength(3);
      expect(body(ends[0])["turn_duration_ms"]).toBe(9500);
      expect(body(ends[0])["stop_reason"]).toBe("end_turn");
      expect(ends[0]?.ts).toBe("2026-08-10T10:00:10.500Z");
    });

    it("a turn with no turn_duration closes at its last reply", () => {
      const ends = ofKind(root, "turn_end");
      expect(ends[1]?.ts).toBe("2026-08-10T10:00:17.000Z");
      expect(body(ends[1])["stop_reason"]).toBe("end_turn");
      expect(ends[1]?.attrs["oxagen.synthesized_from"]).toBe("assistant:a-0006");
      // The last turn has no reply, and the end of the file closes it.
      expect(ends[2]?.ts).toBe("2026-08-10T10:00:20.000Z");
    });

    it("assistant record: llm_call per requestId, later blocks without usage", () => {
      const calls = ofKind(root, "llm_call");
      const first = calls.find((e) => body(e)["request_id"] === "req_0001");
      expect(body(first)).toMatchObject({
        model: "claude-synthetic-1",
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 30,
        cache_creation_tokens: 40,
        cache_creation_5m_tokens: 40,
        thinking_tokens: 5,
        cost_basis: "estimated",
      });
      const later = calls.filter(
        (e) =>
          body(e)["request_id"] === "req_0001" &&
          e.attrs["oxagen.llm_call_duplicate_of"] !== undefined,
      );
      expect(later).toHaveLength(1);
      expect(body(later[0])["input_tokens"]).toBeUndefined();
    });

    it("API error record: error", () => {
      const errors = ofKind(root, "error");
      expect(errors).toHaveLength(1);
      expect(body(errors[0])["api_error_class"]).toBe("rate_limit");
    });

    it("tool_use block: tool_requested; tool_result: tool_call", () => {
      const requested = ofKind(root, "tool_requested");
      expect(requested.map((e) => body(e)["tool_use_id"])).toEqual([
        "toolu_bash_0001",
        "toolu_agent_0001",
      ]);
      expect(body(requested[0])["tool_name"]).toBe("Bash");
      const calls = ofKind(root, "tool_call");
      expect(calls.map((e) => body(e)["tool_use_id"])).toEqual([
        "toolu_bash_0001",
        "toolu_agent_0001",
      ]);
    });

    it("Agent call joined to a subagent file: subagent_start and subagent_stop", () => {
      const start = ofKind(root, "subagent_start")[0];
      expect(body(start)["tool_use_id"]).toBe("toolu_agent_0001");
      expect(start?.attrs["hook.agent_id"]).toBe("sub0001");
      expect(start?.ts).toBe("2026-08-10T10:00:04.000Z");
      const stops = ofKind(root, "subagent_stop");
      const stop = stops.find((e) => e.attrs["hook.agent_id"] === "sub0001");
      expect(body(stop)["tool_use_id"]).toBe("toolu_agent_0001");
      expect(body(stop)["tool_status"]).toBe("ok");
      expect(stop?.ts).toBe("2026-08-10T10:00:09.000Z");
    });

    it("subagent records: the child's own chain, mapped by the same table", () => {
      const spawned = children.filter(
        (e) => e.subagent?.subagent_id === "sub0001",
      );
      expect(spawned[0]?.kind).toBe("agent_start");
      expect(spawned[0]?.parent_session_uuid).toBe(root[0]?.session_uuid);
      expect(spawned[0]?.root_session_uuid).toBe(root[0]?.session_uuid);
      for (const event of spawned) {
        expect(event.subagent?.spawn_tool_use_id).toBe("toolu_agent_0001");
        expect(event.subagent?.subagent_type).toBe("Explore");
      }
      expect(
        ofKind(spawned, "tool_requested").map((e) => body(e)["tool_use_id"]),
      ).toEqual(["toolu_read_0001"]);
      expect(ofKind(spawned, "tool_call")).toHaveLength(1);
      expect(ofKind(spawned, "llm_call")).toHaveLength(2);
      expect(spawned.at(-1)?.kind).toBe("agent_stop");
    });

    it("a subagent no call names keeps its parent link and no spawning call", () => {
      const orphan = children.filter(
        (e) => e.subagent?.subagent_id === "orph0001",
      );
      expect(orphan.length).toBeGreaterThan(0);
      for (const event of orphan) {
        expect(event.parent_session_uuid).toBe(root[0]?.session_uuid);
        expect(event.subagent?.spawn_tool_use_id).toBeUndefined();
      }
      expect(
        ofKind(root, "subagent_stop").some(
          (e) => e.attrs["hook.agent_id"] === "orph0001",
        ),
      ).toBe(true);
    });

    it("compact_boundary: oxagen:compaction with its token counts", () => {
      const compaction = ofKind(root, "oxagen:compaction");
      expect(compaction).toHaveLength(1);
      expect(body(compaction[0])).toMatchObject({
        compact_trigger: "auto",
        tokens_before: 150_000,
        tokens_after: 12_000,
      });
    });

    it("the transcript-only records map through the normalizer", () => {
      expect(ofKind(root, "oxagen:hook_health")).toHaveLength(1);
      expect(body(ofKind(root, "oxagen:api_retry")[0])).toMatchObject({
        api_retry_attempt: 1,
        api_status_code: 529,
      });
      expect(
        ofKind(root, "oxagen:permission_mode_change").map(
          (e) => body(e)["permission_mode_to"],
        ),
      ).toEqual(["default", "acceptEdits"]);
      expect(ofKind(root, "oxagen:worktree")[0]?.context).toMatchObject({
        worktree_path: "/work/synthetic-worktree",
      });
      expect(body(ofKind(root, "oxagen:cwd_change")[0])["cwd_new"]).toBe(
        "/work/synthetic-relocated",
      );
      expect(ofKind(root, "oxagen:queue")).toHaveLength(1);
      expect(ofKind(root, "oxagen:pr_link")[0]?.attrs["pr.number"]).toBe(
        "4242",
      );
      expect(
        ofKind(root, "oxagen:session_title").map((e) => e.hook_source_kind),
      ).toEqual(["ai-title", "custom-title"]);
    });

    it("an unparseable line is a gap naming its byte offset", () => {
      const gaps = ofKind(root, "telemetry_gap");
      expect(gaps).toHaveLength(1);
      expect(gaps[0]?.attrs["gap.reason"]).toBe("transcript_line_unparseable");
      expect(gaps[0]?.attrs["gap.detail"]).toMatch(/^byte offset \d+$/);
    });
  });

  it("never produces what nothing witnessed", () => {
    const { events } = fixturePass();
    const never = [
      "policy_decision",
      "approval_request",
      "approval_decision",
      "token_issued",
      "token_use",
      "token_denied",
      "harness_permission",
      "steering.manifest",
      "proof.observed",
      "checkpoint",
      "oxagen:instructions_loaded",
      "oxagen:config_change",
      "oxagen:mcp_connection",
      "oxagen:notification",
      "oxagen:elicitation",
      "oxagen:rate_limit",
      "oxagen:auth",
      "oxagen:plugin_install",
      "oxagen:hooks_removed",
      "oxagen:kill_attempted",
      "oxagen:command_applied",
      "oxagen:unobserved_session",
      "network",
      "oxagen:file_changed",
      "oxagen:model_switch",
    ];
    const kinds = new Set(events.map((e) => e.kind));
    for (const kind of never) expect(kinds.has(kind as TachoEvent["kind"])).toBe(false);
    // The only gaps are the backfill's own read failures.
    for (const gap of ofKind(events, "telemetry_gap"))
      expect(gap.attrs["gap.reason"]).toMatch(/^transcript_line_/);
    for (const start of ofKind(events, "agent_start")) {
      for (const key of [
        "env_snapshot",
        "settings_sources",
        "hooks_registered",
        "available_models",
        "always_thinking_enabled",
        "effort_level_setting",
        "transcript_path",
      ])
        expect(body(start)[key]).toBeUndefined();
    }
    for (const event of events) {
      const context = (event.context ?? {}) as Record<string, unknown>;
      for (const key of ["git_head_sha", "git_dirty", "git_remote_digest"])
        expect(context[key]).toBeUndefined();
    }
  });

  it("counts what it read, ignored, and could not read", () => {
    const { driver } = fixturePass();
    const tally = driver.tally;
    expect(tally.recordsIgnored).toMatchObject({
      attachment: 1,
      "file-history-snapshot": 1,
      "fork-context-ref": 1,
      "last-prompt": 1,
    });
    expect(tally.drift.unknownTypes).toEqual({ "brand-new-record": 1 });
    expect(tally.drift.untestedVersionSessions).toBe(0);
    expect(tally.errors.unparseableLines).toBe(1);
    expect(tally.harnessReportedCostMicros).toBe(125_000);
    expect(tally.sessionsWithCostState).toBe(1);
    expect(tally.tokens["claude-synthetic-1"]).toMatchObject({
      input_tokens: 10 + 5 + 7,
      output_tokens: 20 + 6 + 8,
    });
    expect(tally.frames["turn_start"]).toBe(3);
    expect(tally.synthesized).toBeGreaterThan(10);
    // Counts only: no value in the tally holds transcript text.
    expect(JSON.stringify(tally)).not.toContain(SENTINEL);
  });
});

describe("a backfill's edge cases", () => {
  const SID = "0b1f0000-0000-4000-8000-00000000b002";
  const record = (fields: Record<string, unknown>): string =>
    JSON.stringify({ sessionId: SID, cwd: "/work/x", version: "2.1.281", ...fields });

  it("reads a session from an untested Claude Code version and marks it", () => {
    const pass = backfill(
      SID,
      [
        record({
          type: "user",
          uuid: "u1",
          timestamp: "2026-08-11T09:00:00.000Z",
          version: "2.0.1",
          message: { role: "user", content: "synthetic" },
        }),
      ],
      {},
    );
    expect(pass.events[0]?.attrs["oxagen.normalizer_untested_version"]).toBe(
      "2.0.1",
    );
    expect(pass.driver.tally.drift.untestedVersionSessions).toBe(1);
    expect(ofKind(pass.events, "turn_start")).toHaveLength(1);
  });

  it("seals no chain for a file with no timed record", () => {
    const pass = backfill(
      SID,
      [JSON.stringify({ type: "ai-title", aiTitle: "synthetic", sessionId: SID })],
      {},
    );
    expect(pass.events).toEqual([]);
    expect(pass.driver.hasChain).toBe(false);
  });

  it("links a subagent by its tool result before meta.json and its own records", () => {
    const spawn = (id: string, ts: string) =>
      record({
        type: "assistant",
        uuid: `a-${id}`,
        timestamp: ts,
        requestId: `req-${id}`,
        message: {
          id: `msg-${id}`,
          model: "claude-synthetic-1",
          content: [{ type: "tool_use", id, name: "Task", input: {} }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
    const result = (id: string, agentId: string | undefined, ts: string) =>
      record({
        type: "user",
        uuid: `r-${id}`,
        timestamp: ts,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: "x" }],
        },
        ...(agentId !== undefined ? { toolUseResult: { agentId } } : {}),
      });
    const sub = (agentId: string, source?: string) => [
      record({
        type: "user",
        uuid: `s-${agentId}`,
        agentId,
        timestamp: "2026-08-11T09:00:02.000Z",
        ...(source !== undefined ? { sourceToolUseID: source } : {}),
        message: { role: "user", content: "synthetic task" },
      }),
    ];
    const pass = backfill(
      SID,
      [
        record({
          type: "user",
          uuid: "u1",
          timestamp: "2026-08-11T09:00:00.000Z",
          message: { role: "user", content: "synthetic" },
        }),
        spawn("toolu_a", "2026-08-11T09:00:01.000Z"),
        spawn("toolu_b", "2026-08-11T09:00:01.100Z"),
        spawn("toolu_c", "2026-08-11T09:00:01.200Z"),
        result("toolu_a", "agentresult", "2026-08-11T09:00:03.000Z"),
        result("toolu_b", undefined, "2026-08-11T09:00:03.100Z"),
        result("toolu_c", undefined, "2026-08-11T09:00:03.200Z"),
      ],
      {
        // Named by the parent's result, and by a meta.json that disagrees.
        agentresult: sub("agentresult"),
        // Named only by meta.json.
        agentmeta: sub("agentmeta"),
        // Named only by its own records.
        agentsource: sub("agentsource", "toolu_c"),
      },
      {
        agentresult: { toolUseId: "toolu_b" },
        agentmeta: { toolUseId: "toolu_b" },
      },
    );
    const spawnOf = (agentId: string) =>
      pass.events.find(
        (e) => e.kind === "subagent_start" && e.attrs["hook.agent_id"] === agentId,
      );
    expect(body(spawnOf("agentresult"))["tool_use_id"]).toBe("toolu_a");
    expect(body(spawnOf("agentmeta"))["tool_use_id"]).toBe("toolu_b");
    expect(body(spawnOf("agentsource"))["tool_use_id"]).toBe("toolu_c");
  });
});
