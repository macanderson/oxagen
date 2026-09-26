/**
 * The daemon reading a Claude Code transcript: a session that reported a
 * `transcript_path` on SessionStart has `llm_call` frames with model, token
 * tiers and thinking tokens on its chain after a tick, each call counted
 * once however many content blocks the harness wrote it as; a SubagentStop
 * feeds the subagent's transcript to the child chain; an OTel `api_request`
 * for a call the transcript already sealed is stamped as its duplicate; the
 * assistant's text and the prompt ship as bodies. Kept apart from
 * daemon.test.ts, which points the detector at an empty transcript root and
 * never writes one.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LLM_CALL_DUPLICATE_OF_ATTR } from "../claude-code/llm-call-dedupe";
import type { TachoEvent } from "../envelope";
import type { FetchLike } from "../host/control-client";
import { writeSensitiveFileAtomic } from "../host/fs";
import { writeHostFile } from "../host/host-file";
import { mergeTachoSettings } from "../host/settings-writer";
import {
  bundleSigner,
  scratchPaths,
  TEST_ENROLLMENT,
  testHostFile,
  unsignedBundle,
} from "../host/test-support";
import type { TachoBody } from "../wire";
import { type DaemonHandle, startDaemon } from "./daemon";

const FIXTURES = join(__dirname, "..", "..", "fixtures", "claude-code");
const SESSION_ID = "340ed354-6344-4727-9f8b-1e40b5e12aa7";
const SUBAGENT_ID = "aebd5e72360a0fb91";

/** A control plane that accepts every batch and keeps what it was sent. */
function plane() {
  const events: TachoEvent[] = [];
  const bodies: TachoBody[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    const control = {
      host_status: "active",
      deny_generation: { org: 1, workspace: 1 },
      bundle_etag: "etag-3",
      commands: [],
    };
    if (url.endsWith("/events")) {
      const batch = body["events"] as TachoEvent[];
      events.push(...batch);
      bodies.push(...((body["bodies"] as TachoBody[] | undefined) ?? []));
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            accepted: batch.length,
            event_ids: batch.map((e) => e.event_id_idem),
            chain_breaks: [],
            control,
          }),
      };
    }
    if (url.endsWith("/bundle")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ not_modified: true, etag: "etag-3", bundle: null }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ acknowledged: 0, control }),
    };
  };
  return { fetch, events, bodies };
}

function post(port: number, token: string, path: string, body: unknown) {
  return new Promise<number>((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

describe("tachod and the transcript", () => {
  const handles: DaemonHandle[] = [];
  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.stop();
  });

  async function boot() {
    const paths = scratchPaths();
    const signer = bundleSigner();
    const bundle = signer.sign(
      unsignedBundle({
        retention: { mode: "content_exact", classes: ["model_call"] },
      }),
    );
    const host = testHostFile(signer, bundle);
    writeHostFile(paths.hostFile, host);
    writeSensitiveFileAtomic(
      paths.claudeSettings,
      JSON.stringify(
        mergeTachoSettings(
          {},
          {
            enrollmentId: TEST_ENROLLMENT,
            hookCommand: "x",
            port: 1,
            localToken: host.local_token,
          },
        ).settings,
      ),
    );
    const control = plane();
    const log: string[] = [];
    const handle = await startDaemon({
      paths,
      fetch: control.fetch,
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line) => log.push(line),
      port: 0,
      transcriptRoots: [join(paths.root, "no-transcripts")],
      timers: { detectorMs: 0, sweepMs: 0, checkpointMs: 0, commandsPollMs: 0 },
    });
    handles.push(handle);
    // The transcript lives where Claude Code would put it, under a project
    // directory the session names on SessionStart.
    const project = join(paths.claudeProjects, "-home-dev-proj");
    mkdirSync(join(project, SESSION_ID, "subagents"), { recursive: true });
    const transcript = join(project, `${SESSION_ID}.jsonl`);
    const subagentTranscript = join(
      project,
      SESSION_ID,
      "subagents",
      `agent-${SUBAGENT_ID}.jsonl`,
    );
    return {
      handle,
      host,
      paths,
      log,
      control,
      transcript,
      subagentTranscript,
      port: handle.port as number,
    };
  }

  it("seals one llm_call per model call with model, token tiers and thinking tokens, and ships the bodies", async () => {
    const { handle, host, port, control, transcript } = await boot();
    expect(
      await post(port, host.local_token, "/hook", {
        session_id: SESSION_ID,
        hook_event_name: "SessionStart",
        transcript_path: transcript,
        cwd: "/home/dev/proj",
      }),
    ).toBe(200);
    // Nothing yet: the file appears after the first message.
    await handle.tick();
    copyFileSync(join(FIXTURES, "transcript", "session.jsonl"), transcript);
    await handle.tick();
    await handle.tick();

    const uuid = handle.registry.get(SESSION_ID)?.recorder.sessionUuid ?? "";
    const chain = handle.wal.read(uuid);
    const calls = chain.filter(
      (e) => e.kind === "llm_call" && e.source === "transcript",
    );
    // The fixture holds five model calls written as eleven assistant
    // records; five carry usage, six are continuation blocks.
    expect(calls).toHaveLength(11);
    const counted = calls.filter(
      (e) => e.attrs[LLM_CALL_DUPLICATE_OF_ATTR] === undefined,
    );
    expect(counted).toHaveLength(5);
    const first = counted[0]?.body as Record<string, unknown>;
    expect(first).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      request_id: "req_011CeqnVhkJe3jmwrGBRxbqT",
      message_id: "msg_011CeqnViXgmDKU79CWUshxM",
      input_tokens: 10,
      output_tokens: 520,
      cache_read_tokens: 0,
      cache_creation_tokens: 27955,
      cache_creation_1h_tokens: 27955,
      cache_creation_5m_tokens: 0,
      thinking_tokens: 379,
    });
    const continuations = calls.filter(
      (e) => e.attrs[LLM_CALL_DUPLICATE_OF_ATTR] === "transcript",
    );
    expect(continuations).toHaveLength(6);
    for (const block of continuations) {
      const body = block.body as Record<string, unknown>;
      expect(body["input_tokens"]).toBeUndefined();
      expect(body["thinking_tokens"]).toBeUndefined();
      expect(body["request_id"]).toBeDefined();
    }
    // Every request id is counted exactly once.
    const ids = counted.map(
      (e) => (e.body as { request_id: string }).request_id,
    );
    expect(new Set(ids).size).toBe(5);

    // The prompt and the assistant's text left as bodies, the tool uses
    // written as JSON lines in the text.
    await handle.tick();
    const texts = control.bodies.map((b) =>
      Buffer.from(b.bytes_base64, "base64").toString("utf8"),
    );
    expect(
      texts.some((t) => t.startsWith("Read README.md, then run the bash")),
    ).toBe(true);
    expect(texts.some((t) => t.includes('{"tool_use":{'))).toBe(true);
    const shippedIds = new Set(control.events.map((e) => e.event_id_idem));
    for (const body of control.bodies)
      expect(shippedIds.has(body.event_id_idem)).toBe(true);
  });

  it("feeds a finished subagent transcript to the child chain on SubagentStop, once", async () => {
    const { handle, host, port, transcript, subagentTranscript, log } =
      await boot();
    copyFileSync(
      join(FIXTURES, "transcript", `subagent-${SUBAGENT_ID}.jsonl`),
      subagentTranscript,
    );
    writeFileSync(transcript, "");
    expect(
      await post(port, host.local_token, "/hook", {
        session_id: SESSION_ID,
        hook_event_name: "SessionStart",
        transcript_path: transcript,
      }),
    ).toBe(200);
    expect(
      await post(port, host.local_token, "/hook", {
        session_id: SESSION_ID,
        hook_event_name: "SubagentStart",
        agent_id: SUBAGENT_ID,
        agent_type: "Explore",
      }),
    ).toBe(200);
    const stop = {
      session_id: SESSION_ID,
      hook_event_name: "SubagentStop",
      agent_id: SUBAGENT_ID,
      agent_type: "Explore",
      agent_transcript_path: subagentTranscript,
    };
    expect(await post(port, host.local_token, "/hook", stop)).toBe(200);
    const parent = handle.registry.get(SESSION_ID)?.recorder;
    const child = parent?.snapshot().children[0];
    expect(child).toBeDefined();
    const childCalls = (child?.events ?? []).filter(
      (e) => e.kind === "llm_call" && e.source === "transcript",
    );
    expect(childCalls.length).toBeGreaterThan(0);
    expect(childCalls[0]?.subagent?.subagent_id).toBe(SUBAGENT_ID);
    // The child's chain closes after its transcript, not before it.
    const kinds = (child?.events ?? []).map((e) => e.kind);
    expect(kinds.indexOf("agent_stop")).toBeGreaterThan(
      kinds.indexOf("llm_call"),
    );
    // A replayed SubagentStop adds no transcript frames.
    expect(await post(port, host.local_token, "/hook", stop)).toBe(200);
    const again = parent?.snapshot().children[0];
    expect(
      (again?.events ?? []).filter(
        (e) => e.kind === "llm_call" && e.source === "transcript",
      ),
    ).toHaveLength(childCalls.length);
    expect(log.some((l) => l.includes("was not there"))).toBe(false);
  });

  it("tails a running subagent's transcript onto the child chain before its SubagentStop", async () => {
    const { handle, host, port, transcript, subagentTranscript } = await boot();
    writeFileSync(transcript, "");
    expect(
      await post(port, host.local_token, "/hook", {
        session_id: SESSION_ID,
        hook_event_name: "SessionStart",
        transcript_path: transcript,
      }),
    ).toBe(200);
    expect(
      await post(port, host.local_token, "/hook", {
        session_id: SESSION_ID,
        hook_event_name: "SubagentStart",
        agent_id: SUBAGENT_ID,
        agent_type: "Explore",
      }),
    ).toBe(200);
    copyFileSync(
      join(FIXTURES, "transcript", `subagent-${SUBAGENT_ID}.jsonl`),
      subagentTranscript,
    );
    await handle.tick();
    const parent = handle.registry.get(SESSION_ID)?.recorder;
    const transcriptCalls = () =>
      (parent?.snapshot().children[0]?.events ?? []).filter(
        (e) => e.kind === "llm_call" && e.source === "transcript",
      );
    // On the child chain while the subagent still runs.
    const live = transcriptCalls();
    expect(live.length).toBeGreaterThan(0);
    expect(live[0]?.subagent?.subagent_id).toBe(SUBAGENT_ID);
    expect(
      parent?.snapshot().children[0]?.events.map((e) => e.kind),
    ).not.toContain("agent_stop");

    // The SubagentStop that follows seals no second copy.
    expect(
      await post(port, host.local_token, "/hook", {
        session_id: SESSION_ID,
        hook_event_name: "SubagentStop",
        agent_id: SUBAGENT_ID,
        agent_type: "Explore",
        agent_transcript_path: subagentTranscript,
      }),
    ).toBe(200);
    expect(transcriptCalls()).toHaveLength(live.length);
    expect(parent?.snapshot().children[0]?.events.map((e) => e.kind)).toContain(
      "agent_stop",
    );
  });

  it("stamps an OTel api_request for a call the transcript already sealed as its duplicate", async () => {
    const { handle, host, port, transcript } = await boot();
    expect(
      await post(port, host.local_token, "/hook", {
        session_id: SESSION_ID,
        hook_event_name: "SessionStart",
        transcript_path: transcript,
      }),
    ).toBe(200);
    copyFileSync(join(FIXTURES, "transcript", "session.jsonl"), transcript);
    await handle.tick();
    const logs = JSON.parse(
      readFileSync(join(FIXTURES, "otlp", "03-v1_logs.json"), "utf8"),
    ) as unknown;
    expect(await post(port, host.local_token, "/v1/logs", logs)).toBe(200);
    const uuid = handle.registry.get(SESSION_ID)?.recorder.sessionUuid ?? "";
    const otel = handle.wal
      .read(uuid)
      .filter((e) => e.kind === "llm_call" && e.source === "otel_log");
    expect(otel).toHaveLength(1);
    expect(otel[0]?.attrs[LLM_CALL_DUPLICATE_OF_ATTR]).toBe("transcript");
    expect((otel[0]?.body as { request_id?: string }).request_id).toBe(
      "req_011CeqnVhkJe3jmwrGBRxbqT",
    );
    // Posted again, the same record is a repeat and adds nothing.
    expect(await post(port, host.local_token, "/v1/logs", logs)).toBe(200);
    expect(
      handle.wal
        .read(uuid)
        .filter((e) => e.kind === "llm_call" && e.source === "otel_log"),
    ).toHaveLength(1);
  });

  it("drains the transcript before SessionEnd and continues from the cursor after a restart", async () => {
    const { handle, host, port, transcript, paths, control } = await boot();
    const lines = readFileSync(
      join(FIXTURES, "transcript", "session.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter((l) => l.length > 0);
    expect(
      await post(port, host.local_token, "/hook", {
        session_id: SESSION_ID,
        hook_event_name: "SessionStart",
        transcript_path: transcript,
      }),
    ).toBe(200);
    writeFileSync(transcript, `${lines.slice(0, 20).join("\n")}\n`);
    await handle.tick();
    const uuid = handle.registry.get(SESSION_ID)?.recorder.sessionUuid ?? "";
    const beforeEvents = handle.wal.read(uuid);
    const before = beforeEvents.length;
    expect(before).toBeGreaterThan(1);

    // A restart: the cursor is on disk, so nothing is sealed twice.
    await handle.stop();
    handles.splice(handles.indexOf(handle), 1);
    const restarted = await startDaemon({
      paths,
      fetch: control.fetch,
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      log: () => undefined,
      port: 0,
      transcriptRoots: [join(paths.root, "no-transcripts")],
      timers: { detectorMs: 0, sweepMs: 0, checkpointMs: 0, commandsPollMs: 0 },
    });
    handles.push(restarted);
    await restarted.tick();
    // The restart itself is recorded: a gap for the window the daemon was not
    // listening, and the checkpoint that signs the head it moved. Nothing from the
    // transcript is sealed a second time.
    const recorded = (events: readonly { kind: string }[]) =>
      events.filter(
        (e) => e.kind !== "telemetry_gap" && e.kind !== "checkpoint",
      ).length;
    const afterRestart = restarted.wal.read(uuid);
    expect(recorded(afterRestart)).toBe(recorded(beforeEvents));
    expect(afterRestart.slice(before).map((e) => e.kind)).toEqual([
      "telemetry_gap",
      "checkpoint",
    ]);

    // The rest lands before SessionEnd seals the chain, and the sealed
    // session is drained once more. The cursor stays as a tombstone until
    // the registry forgets the session.
    writeFileSync(transcript, `${lines.join("\n")}\n`);
    expect(
      await post(restarted.port as number, host.local_token, "/hook", {
        session_id: SESSION_ID,
        hook_event_name: "SessionEnd",
        reason: "other",
      }),
    ).toBe(200);
    await restarted.flushGitReads();
    const chain = restarted.wal.read(uuid);
    const kinds = chain.map((e) => e.kind);
    const lastCall = kinds.lastIndexOf("llm_call");
    expect(lastCall).toBeGreaterThan(0);
    expect(kinds.indexOf("agent_stop")).toBeGreaterThan(lastCall);
    await restarted.tick();
    await restarted.tick();
    await restarted.tick();
    // A sealed session's transcript is still watched until it has been quiet
    // for `sealedIdleMs`, because the last message is often written after
    // SessionEnd; its cursor is kept meanwhile.
    expect(
      restarted.transcriptTailer.state().cursors[
        `claude-code:claude-code ${SESSION_ID}`
      ],
    ).toBeDefined();
    // No tick after the drain appends the transcript to the sealed chain again.
    expect(restarted.wal.read(uuid).length).toBe(chain.length);
  });
});
