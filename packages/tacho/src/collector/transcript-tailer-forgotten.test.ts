/**
 * A session resumed after the registry forgot it (#4345). `forgetSealed`
 * drops a sealed session a week after it was last seen and keeps a chain
 * tombstone for thirty days, so a resume under the same id continues the
 * chain. The tailer keeps the session's transcript cursor for the same
 * span, so the resume reads on from the last line read before the session
 * was forgotten. The tailer used to drop the cursor, and the resume fed the
 * whole transcript again: every earlier model call sealed a second
 * `llm_call` on the continued chain.
 */
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import {
  bundleSigner,
  TEST_ENROLLMENT,
  unsignedBundle,
} from "../host/test-support";
import { handleHookEvent, type PolicyView } from "./hook-handler";
import {
  MAX_TOMBSTONES,
  type RegistryState,
  SessionRegistry,
  sessionMapKey,
  TOMBSTONE_RETAIN_MS,
} from "./registry";
import {
  DEFAULT_SEALED_TAIL_IDLE_MS,
  type TailedSession,
  TranscriptTailer,
} from "./transcript-tailer";

const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

const DAY_MS = 24 * 60 * 60_000;
const SESSION = "sess-1";
const KEY = sessionMapKey(SESSION);

/** One transcript `assistant` record, which is one model call. */
function assistantLine(requestId: string, at: number): string {
  const record = {
    type: "assistant",
    timestamp: new Date(at).toISOString(),
    requestId,
    message: {
      id: `msg_${requestId}`,
      model: "claude-haiku-4-5",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "ok" }],
    },
  };
  return `${JSON.stringify(record)}\n`;
}

/** The request id of every `llm_call` frame on the chain, in order. */
function modelCalls(chain: readonly TachoEvent[]): Array<string | undefined> {
  return chain
    .filter((event) => event.kind === "llm_call")
    .map((event) => (event.body as { request_id?: string }).request_id);
}

/** A recorder that only remembers the lines it was handed. */
function fakeSession(id: string, transcriptPath: string) {
  const lines: string[] = [];
  const recorder = {
    ingestTranscriptLine(line: string): TachoEvent[] {
      lines.push(line);
      return [];
    },
    takeBodies(): FrameBody[] {
      return [];
    },
    markChain: () => ({}),
    rollbackChain: () => undefined,
    sealCollectorEvent: () => ({ kind: "telemetry_gap" }) as unknown,
  };
  const session: TailedSession = {
    harnessSessionId: id,
    transcriptPath,
    sealed: false,
    recorder: recorder as unknown as TailedSession["recorder"],
  };
  return { session, lines };
}

describe("a session resumed after the registry forgot it", () => {
  const dirs: string[] = [];
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "tacho-tail-forgotten-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  /**
   * A real registry and tailer on one clock, fed by real hooks, with every
   * frame either of them seals collected on one chain in seal order.
   */
  function rig() {
    const dir = scratch();
    let clock = Date.parse("2026-09-01T10:00:00.000Z");
    const now = () => clock;
    const advance = (ms: number) => {
      clock += ms;
    };
    const bundle = bundleSigner().sign(unsignedBundle());
    const view: PolicyView = {
      bundle,
      verified: true,
      hostStatus: "active",
      denyGeneration: bundle.deny_generation,
      controlReachable: true,
    };
    const chain: TachoEvent[] = [];
    const transcript = join(dir, `${SESSION}.jsonl`);
    const statePath = join(dir, "transcript-tail.json");
    const hook = async (
      registry: SessionRegistry,
      hookEventName: string,
      extra: Record<string, unknown> = {},
    ): Promise<void> => {
      advance(1_000);
      const outcome = await handleHookEvent(
        {
          session_id: SESSION,
          hook_event_name: hookEventName,
          cwd: "/repo",
          transcript_path: transcript,
          ...extra,
        },
        { CLAUDE_PID: "4242" },
        { registry, policy: () => view, now },
      );
      chain.push(...outcome.events);
    };
    const newRegistry = () =>
      new SessionRegistry({ context: CONTEXT, scope: TEST_ENROLLMENT, now });
    const newTailer = (registry: SessionRegistry) =>
      new TranscriptTailer({
        sessions: () => registry.list(),
        session: (id) => registry.get(id),
        record: (events) => chain.push(...events),
        statePath,
        now,
      });
    return {
      now,
      advance,
      hook,
      chain,
      transcript,
      statePath,
      newRegistry,
      newTailer,
    };
  }

  /**
   * One model call read from the transcript, the session ended, its cursor
   * drained after the quiet grace, and the session forgotten a week later,
   * with one tick of the tailer after the forget, as the daemon runs them.
   */
  async function forgottenAfterOneCall(
    r: ReturnType<typeof rig>,
    registry: SessionRegistry,
    tailer: TranscriptTailer,
  ): Promise<void> {
    await r.hook(registry, "SessionStart", { source: "startup" });
    await r.hook(registry, "UserPromptSubmit", { prompt: "one" });
    writeFileSync(r.transcript, assistantLine("req_1", r.now()));
    await tailer.tick();
    await r.hook(registry, "Stop");
    await r.hook(registry, "SessionEnd", { reason: "other" });
    await tailer.tick();
    r.advance(DEFAULT_SEALED_TAIL_IDLE_MS);
    await tailer.tick();
    expect(tailer.state().cursors[KEY]?.drained).toBe(true);
    r.advance(8 * DAY_MS);
    expect(registry.forgetSealed(7 * DAY_MS)).toEqual([SESSION]);
    await tailer.tick();
  }

  it("feeds the resumed chain only the lines written after the last line read", async () => {
    const r = rig();
    const registry = r.newRegistry();
    const tailer = r.newTailer(registry);
    await forgottenAfterOneCall(r, registry, tailer);
    expect(modelCalls(r.chain)).toEqual(["req_1"]);

    await r.hook(registry, "SessionStart", { source: "resume" });
    await r.hook(registry, "UserPromptSubmit", { prompt: "two" });
    // Written before the next tick: a cursor that started at the end of the
    // file would miss it.
    appendFileSync(r.transcript, assistantLine("req_2", r.now()));
    await tailer.tick();

    // A tailer that dropped the forgotten cursor read from byte 0 here and
    // sealed `req_1` a second time.
    expect(modelCalls(r.chain)).toEqual(["req_1", "req_2"]);
    expect(tailer.state().cursors[KEY]?.forgottenAtMs).toBeUndefined();
    expect(tailer.state().cursors[KEY]?.offset).toBe(
      statSync(r.transcript).size,
    );
  });

  it("keeps the read position across a daemon restart", async () => {
    const r = rig();
    const registry = r.newRegistry();
    await forgottenAfterOneCall(r, registry, r.newTailer(registry));
    const persisted = JSON.parse(readFileSync(r.statePath, "utf8")) as {
      cursors: Record<string, { forgottenAtMs?: number }>;
    };
    expect(persisted.cursors[KEY]?.forgottenAtMs).toBe(r.now());

    // A new daemon: the registry from its state file, the tailer from its own.
    const restarted = r.newRegistry();
    restarted.restore(
      JSON.parse(JSON.stringify(registry.state())) as RegistryState,
    );
    const tailer = r.newTailer(restarted);
    await r.hook(restarted, "SessionStart", { source: "resume" });
    appendFileSync(r.transcript, assistantLine("req_2", r.now()));
    await tailer.tick();

    expect(modelCalls(r.chain)).toEqual(["req_1", "req_2"]);
  });

  it("keeps a cursor from a state file written before forgotten cursors were kept", async () => {
    const dir = scratch();
    const transcript = join(dir, "s1.jsonl");
    const before = '{"n":1}\n';
    writeFileSync(transcript, before);
    const statePath = join(dir, "transcript-tail.json");
    // The shape an older build wrote: no `forgottenAtMs`.
    writeFileSync(
      statePath,
      JSON.stringify({
        schema: "tacho.transcript-tail.v1",
        cursors: {
          [sessionMapKey("s1")]: {
            path: transcript,
            offset: Buffer.byteLength(before),
            ino: statSync(transcript).ino,
            subagents: [],
            drained: true,
          },
        },
      }),
    );
    const listed: TailedSession[] = [];
    let now = 1_000;
    const tailer = new TranscriptTailer({
      sessions: () => listed,
      session: (id) => listed.find((s) => s.harnessSessionId === id),
      record: () => undefined,
      statePath,
      now: () => now,
    });
    await tailer.tick();
    expect(tailer.state().cursors[sessionMapKey("s1")]?.forgottenAtMs).toBe(
      1_000,
    );

    const { session, lines } = fakeSession("s1", transcript);
    listed.push(session);
    appendFileSync(transcript, '{"n":2}\n');
    now = 2_000;
    await tailer.tick();
    expect(lines).toEqual(['{"n":2}']);
  });

  it("takes the cursor back unchanged when the registry lists the session again", async () => {
    const dir = scratch();
    const transcript = join(dir, "s1.jsonl");
    writeFileSync(transcript, '{"n":1}\n');
    const { session, lines } = fakeSession("s1", transcript);
    const listed: TailedSession[] = [session];
    let now = 0;
    const tailer = new TranscriptTailer({
      sessions: () => listed,
      session: (id) => listed.find((s) => s.harnessSessionId === id),
      record: () => undefined,
      now: () => now,
    });
    const cursor = () => tailer.state().cursors[sessionMapKey("s1")];
    await tailer.tick();
    const offset = cursor()?.offset;

    listed.length = 0;
    now = 1_000;
    await tailer.tick();
    expect(cursor()?.forgottenAtMs).toBe(1_000);

    listed.push(session);
    await tailer.tick();
    expect(cursor()?.forgottenAtMs).toBeUndefined();
    expect(cursor()?.offset).toBe(offset);
    // Listed, it is live however long past the retention.
    now = 1_000 + TOMBSTONE_RETAIN_MS + 1;
    await tailer.tick();
    expect(cursor()).toBeDefined();
    expect(lines).toEqual(['{"n":1}']);
  });

  it("drops a forgotten cursor when the chain tombstone would go", async () => {
    const dir = scratch();
    const transcript = join(dir, "s1.jsonl");
    writeFileSync(transcript, '{"n":1}\n');
    const { session } = fakeSession("s1", transcript);
    const listed: TailedSession[] = [session];
    let now = 0;
    const tailer = new TranscriptTailer({
      sessions: () => listed,
      session: (id) => listed.find((s) => s.harnessSessionId === id),
      record: () => undefined,
      now: () => now,
    });
    const cursor = () => tailer.state().cursors[sessionMapKey("s1")];
    await tailer.tick();
    listed.length = 0;
    now = 5_000;
    await tailer.tick();

    now = 5_000 + TOMBSTONE_RETAIN_MS;
    await tailer.tick();
    expect(cursor()?.forgottenAtMs).toBe(5_000);
    now += 1;
    await tailer.tick();
    expect(cursor()).toBeUndefined();
  });

  it("keeps at most MAX_TOMBSTONES forgotten cursors, dropping the oldest", async () => {
    const dir = scratch();
    const statePath = join(dir, "transcript-tail.json");
    const cursors: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_TOMBSTONES; i += 1)
      cursors[sessionMapKey(`s${i}`)] = {
        path: join(dir, `s${i}.jsonl`),
        offset: 0,
        subagents: [],
        drained: true,
        forgottenAtMs: i,
      };
    writeFileSync(
      statePath,
      JSON.stringify({ schema: "tacho.transcript-tail.v1", cursors }),
    );
    const tailer = new TranscriptTailer({
      sessions: () => [],
      session: () => undefined,
      record: () => undefined,
      statePath,
      now: () => MAX_TOMBSTONES + 1,
    });
    await tailer.tick();
    const kept = Object.keys(tailer.state().cursors);
    expect(kept).toHaveLength(MAX_TOMBSTONES);
    expect(kept).not.toContain(sessionMapKey("s0"));
    expect(kept).toContain(sessionMapKey(`s${MAX_TOMBSTONES}`));
  });
});
