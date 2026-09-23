/**
 * Replays the captured Claude Code 2.1.263 session (fixtures/claude-code)
 * through the recorder and holds the result to the package's guarantees:
 * every chain verifies, every row lands on a known column, nothing the
 * harness sent is dropped, and both the parent and the subagent journals
 * pass the CGP oracles.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import { TACHO_EVENT_COLUMNS, flattenEvent, unflattenEvent } from "../columns";
import { digestBytes } from "../digest";
import type { TachoEvent } from "../envelope";
import { redactionMarker } from "../evidence/redaction";
import { TACHO_MAX_BODY_BYTES } from "../wire";
import { journalToNdjson } from "../trace/journal";
import { runOracles } from "../trace/oracles";
import { projectToTrace } from "../trace/project";
import { reportPassed } from "../trace/report";
import { fromUnixNano } from "../timestamp";
import { asClickHouseRead } from "../test-helpers";
import { SessionRecorder } from "./recorder";

const FIXTURES = resolve(__dirname, "../../fixtures/claude-code");
const HOST = "thst_0123456789abcdef0123";

interface HookFixture {
  env: Record<string, string>;
  stdin: Record<string, unknown> & {
    hook_event_name: string;
    session_id: string;
  };
}

interface Step {
  at: string;
  order: number;
  run: (recorder: SessionRecorder) => TachoEvent[];
  label: string;
}

function loadSteps(): { steps: Step[]; sessionId: string } {
  const steps: Step[] = [];
  let order = 0;
  let sessionId = "";
  for (const name of readdirSync(resolve(FIXTURES, "hooks")).sort()) {
    const fixture = JSON.parse(
      readFileSync(resolve(FIXTURES, "hooks", name), "utf8"),
    ) as HookFixture;
    sessionId ||= fixture.stdin.session_id;
    const nanos = name.split("-")[0] ?? "0";
    const at = fromUnixNano(nanos);
    steps.push({
      at,
      order: order++,
      label: `hook:${fixture.stdin.hook_event_name}`,
      run: (r) => r.ingestHook(fixture.stdin, fixture.env, at),
    });
  }
  for (const name of readdirSync(resolve(FIXTURES, "otlp")).sort()) {
    const payload = JSON.parse(
      readFileSync(resolve(FIXTURES, "otlp", name), "utf8"),
    ) as Record<string, unknown>;
    // OTLP posts arrive in batches; order them by the earliest record they carry.
    const text = readFileSync(resolve(FIXTURES, "otlp", name), "utf8");
    const nanos =
      [...text.matchAll(/"(?:timeUnixNano|endTimeUnixNano)": "(\d+)"/g)]
        .map((m) => m[1] ?? "0")
        .sort()[0] ?? "0";
    steps.push({
      at: fromUnixNano(nanos),
      order: order++,
      label: `otlp:${name}`,
      run: (r) => r.ingestOtlp(payload),
    });
  }
  const transcript = readFileSync(
    resolve(FIXTURES, "transcript", "session.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter(Boolean);
  for (const line of transcript) {
    const ts = /"timestamp":"([^"]+)"/.exec(line)?.[1];
    if (!ts) continue;
    steps.push({
      at: new Date(ts).toISOString(),
      order: order++,
      label: "transcript",
      run: (r) => r.ingestTranscriptLine(line),
    });
  }
  const subagentFile = readdirSync(resolve(FIXTURES, "transcript")).find(
    (n) => n.startsWith("subagent-") && n.endsWith(".jsonl"),
  );
  if (subagentFile) {
    const subagentId = subagentFile
      .replace(/^subagent-/, "")
      .replace(/\.jsonl$/, "");
    for (const line of readFileSync(
      resolve(FIXTURES, "transcript", subagentFile),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)) {
      const ts = /"timestamp":"([^"]+)"/.exec(line)?.[1];
      if (!ts) continue;
      steps.push({
        at: new Date(ts).toISOString(),
        order: order++,
        label: "subagent-transcript",
        run: (r) => r.ingestTranscriptLine(line, subagentId),
      });
    }
  }
  steps.sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order,
  );
  return { steps, sessionId };
}

function replay(): { recorder: SessionRecorder; all: TachoEvent[] } {
  const { steps, sessionId } = loadSteps();
  const recorder = new SessionRecorder({
    context: {
      agent: {
        agent_key: "acme.core.cc-laptop",
        fleet_id: "wrk_test",
        runtime: "claude-code",
        harness: "claude-code",
        wrapper_version: "2.1.1",
        host_enrollment_id: HOST,
      },
      now: () => Date.parse("2026-09-08T10:07:00.000Z"),
    },
    harnessSessionId: sessionId,
    scope: HOST,
  });
  const all: TachoEvent[] = [];
  for (const step of steps) {
    all.push(...step.run(recorder));
  }
  const stream = JSON.parse(
    readFileSync(resolve(FIXTURES, "result.json"), "utf8"),
  ) as unknown[];
  for (const record of stream) {
    all.push(...recorder.ingestResultRecord(record));
  }
  all.push(...recorder.finalize("completed"));
  return { recorder, all };
}

describe("replaying the captured Claude Code session", () => {
  const { recorder, all } = replay();
  const snapshot = recorder.snapshot();
  // Taken once, before the tests run: a second take is empty by design.
  const bodies = recorder.takeBodies();

  it("routes the subagent into a child chain linked to the parent", () => {
    expect(snapshot.children).toHaveLength(1);
    const child = snapshot.children[0];
    expect(child?.events[0]?.parent_session_uuid).toBe(snapshot.sessionUuid);
    expect(child?.events[0]?.root_session_uuid).toBe(snapshot.sessionUuid);
    expect(
      child?.events.every((e) => e.subagent?.subagent_id !== undefined),
    ).toBe(true);
    expect(child?.events.some((e) => e.kind === "tool_requested")).toBe(true);
  });

  it("rebuilds every sealed event from its stored row, so an export can carry it (#3733)", () => {
    expect(all.length).toBeGreaterThan(0);
    for (const event of all) {
      expect(unflattenEvent(flattenEvent(event))).toEqual(event);
      expect(unflattenEvent(asClickHouseRead(flattenEvent(event)))).toEqual(
        event,
      );
    }
  });

  it("seals verifiable chains for the parent and the child", () => {
    for (const chain of [snapshot, ...snapshot.children]) {
      const verdict = verifyChain(chain.events);
      expect(verdict.violations).toEqual([]);
      expect(verdict.ok).toBe(true);
    }
    expect(all.length).toBe(
      snapshot.events.length +
        snapshot.children.reduce((n, c) => n + c.events.length, 0),
    );
  });

  it("records every hook event, OpenTelemetry record, and transcript fact", () => {
    const kinds = new Set(snapshot.events.map((e) => e.kind));
    for (const kind of [
      "agent_start",
      "oxagen:instructions_loaded",
      "turn_start",
      "tool_requested",
      "tool_call",
      "file_io",
      "command",
      "policy_decision",
      "subagent_start",
      "oxagen:message",
      "turn_end",
      "agent_stop",
      "llm_call",
      "oxagen:hook_health",
      "oxagen:mcp_connection",
    ]) {
      expect(kinds.has(kind as TachoEvent["kind"]), kind).toBe(true);
    }
    const sources = new Set(snapshot.events.map((e) => e.source));
    for (const source of [
      "hook",
      "otel_log",
      "otel_span",
      "result",
      "transcript",
    ]) {
      expect(sources.has(source as TachoEvent["source"]), source).toBe(true);
    }
    expect(snapshot.children[0]?.events[0]?.source).toBe("collector");
    const llm = snapshot.events.find(
      (e) => e.kind === "llm_call" && e.source === "otel_log",
    );
    expect(llm?.body).toMatchObject({ model: "claude-haiku-4-5-20251001" });
    expect(
      (llm?.body as Record<string, unknown>)["cost_usd_micros"],
    ).toBeGreaterThan(0);
    expect(llm?.anthropic?.account_uuid).toBe(
      "00000000-0000-4000-8000-00000000acc7",
    );
    expect(llm?.context?.terminal_type).toBe("ghostty");
    expect(llm?.host?.os_type).toBe("darwin");
    const transcriptLlm = snapshot.events.find(
      (e) => e.kind === "llm_call" && e.source === "transcript",
    );
    expect(
      (transcriptLlm?.body as Record<string, unknown>)[
        "cache_creation_1h_tokens"
      ],
    ).toBeGreaterThan(0);
    const genesis = snapshot.events[0];
    expect(genesis?.kind).toBe("agent_start");
    expect(
      (genesis?.body as Record<string, unknown>)["env_snapshot"],
    ).toMatchObject({
      CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
      CLAUDE_EFFORT: "high",
    });
    expect(JSON.stringify(genesis?.body)).not.toContain("API_KEY");
    expect(genesis?.host?.claude_pid).toBeGreaterThan(0);
    expect(genesis?.agent.harness_version).toBe("2.1.263");
    expect(recorder.totals.total_cost_usd_micros).toBeGreaterThan(0);
    expect(recorder.metrics.some((m) => m.name === "cost.usage")).toBe(true);
  });

  it("digests every body and never records prompt or tool bytes", () => {
    const text = JSON.stringify(snapshot.events.map((e) => e.body));
    expect(text).not.toContain("Read README.md, then run");
    // The command head is kept on purpose (data-model section 0.2); nothing else carries it.
    const bodies = snapshot.events.map((e) => {
      const {
        tool_target: _t,
        tool_targets: _ts,
        ...rest
      } = e.body as Record<string, unknown>;
      return rest;
    });
    expect(JSON.stringify(bodies)).not.toContain("tacho-probe");
    const command = snapshot.events.find((e) => e.kind === "command");
    expect((command?.body as Record<string, unknown>)["tool_target"]).toBe(
      "echo tacho-probe",
    );
    expect((command?.body as Record<string, unknown>)["effect_id"]).toMatch(
      /^eff_[0-9a-f]{64}$/,
    );
    const write = snapshot.events.find((e) => e.kind === "file_io");
    expect((write?.body as Record<string, unknown>)["tool_target"]).toMatch(
      /probe\.txt$/,
    );
  });

  it("holds a body for every content frame, digested as the chain digests it", () => {
    const events = new Map(
      [snapshot, ...snapshot.children]
        .flatMap((chain) => chain.events)
        .map((event) => [event.event_id_idem, event] as const),
    );
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      const event = events.get(body.event_id_idem);
      expect(event, body.event_id_idem).toBeDefined();
      expect(event?.session_uuid).toBe(body.session_uuid);
      expect(event?.seq).toBe(body.seq);
      expect(event?.content?.digest).toBe(digestBytes(body.bytes));
    }
    // The prompt the events never spell out is in its body, in full.
    const turnStart = snapshot.events.find((e) => e.kind === "turn_start");
    const prompt = bodies.find(
      (b) => b.event_id_idem === turnStart?.event_id_idem,
    );
    expect(prompt?.content_type).toBe("text/plain; charset=utf-8");
    expect(new TextDecoder().decode(prompt?.bytes)).toContain(
      "Read README.md, then run",
    );
    // Tool bodies come from both chains: the subagent's are its own.
    const child = snapshot.children[0];
    expect(
      bodies.some(
        (b) =>
          b.session_uuid === child?.sessionUuid &&
          b.content_class === "tool_call",
      ),
    ).toBe(true);
    // Drained means drained.
    expect(recorder.takeBodies()).toEqual([]);
  });

  it("flattens every event onto known columns only", () => {
    const known = new Set<string>(TACHO_EVENT_COLUMNS);
    for (const chain of [snapshot, ...snapshot.children]) {
      for (const event of chain.events) {
        const row = flattenEvent(event);
        for (const column of Object.keys(row)) {
          expect(known.has(column), column).toBe(true);
        }
        expect(row["session_uuid"]).toBe(chain.sessionUuid);
      }
    }
  });

  it("projects both chains onto journals that pass the CGP oracles", () => {
    for (const chain of [snapshot, ...snapshot.children]) {
      const journal = projectToTrace(chain.events);
      const report = runOracles(journal);
      const failures = report.checks
        .filter((c) => c.status === "fail")
        .map((c) => `${c.name}: ${c.evidence}`);
      expect(failures, journalToNdjson(journal)).toEqual([]);
      expect(reportPassed(report)).toBe(true);
      expect(journal.events[0]?.event).toBe("session_start");
      expect(journal.events[journal.events.length - 1]?.event).toBe(
        "session_end",
      );
    }
  });
});

describe("the recorder's frame bodies", () => {
  const SESSION = "00000000-0000-4000-8000-00000000abcd";
  const dec = new TextDecoder();
  function recorder(): SessionRecorder {
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
        now: () => Date.parse("2026-09-18T10:00:00.000Z"),
      },
      harnessSessionId: SESSION,
      scope: HOST,
    });
  }

  it("redacts a secret before digesting and records the cut on the event", () => {
    const r = recorder();
    const key = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd";
    const [event] = r.ingestHook(
      {
        session_id: SESSION,
        hook_event_name: "UserPromptSubmit",
        prompt: `push with ${key} please`,
      },
      {},
    );
    const [body] = r.takeBodies();
    const shipped = `push with ${redactionMarker("github_token")} please`;
    expect(dec.decode(body?.bytes)).toBe(shipped);
    expect(event?.content?.digest).toBe(digestBytes(shipped));
    expect(event?.content?.redactions).toEqual([
      {
        path: `bytes:10-${10 + key.length}`,
        reason: "github_token",
        original_digest: digestBytes(key),
      },
    ]);
    // The raw prompt's digest is still the column; the chain names the bytes.
    expect((event?.body as Record<string, unknown>)["prompt_digest"]).not.toBe(
      event?.content?.digest,
    );
    expect(JSON.stringify(event)).not.toContain(key);
    expect(verifyChain(r.sealedEvents).ok).toBe(true);
  });

  it("keeps the digest and says why when a body is too large to ship", () => {
    const r = recorder();
    const huge = "x".repeat(TACHO_MAX_BODY_BYTES + 1);
    const [event] = r.ingestHook(
      {
        session_id: SESSION,
        hook_event_name: "Stop",
        last_assistant_message: huge,
      },
      {},
    );
    expect(event?.kind).toBe("turn_end");
    expect(event?.content?.digest).toBe(digestBytes(huge));
    expect(event?.attrs["body_omitted"]).toBe("too_large");
    expect(r.takeBodies()).toEqual([]);
  });

  it("holds a body for a collector-sealed frame that carries content", () => {
    const r = recorder();
    const event = r.sealCollectorEvent(
      "tool_call",
      { tool_name: "Bash", tool_source: "builtin", tool_status: "ok" },
      {
        content: {
          content_type: "application/json",
          bytes: new TextEncoder().encode('{"input":{"command":"ls"}}'),
        },
      },
    );
    const [body] = r.takeBodies();
    expect(body).toMatchObject({
      event_id_idem: event.event_id_idem,
      session_uuid: event.session_uuid,
      seq: event.seq,
      content_type: "application/json",
      content_class: "tool_call",
    });
    expect(event.content?.digest).toBe(digestBytes(body?.bytes as Uint8Array));
  });
});
