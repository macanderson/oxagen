/**
 * Who sent a Codex prompt, from recorded Codex shapes. The rollout fixtures
 * are first lines of real Codex 0.155 to 0.159 rollouts, one per surface,
 * with ids, paths, and instructions replaced. The hook fixtures follow
 * Codex's `user-prompt-submit.command.input` schema, and the heartbeat
 * prompt keeps the tag layout a Codex Desktop automation sends.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODEX_SESSION_META_MAX_BYTES,
  codexPromptSource,
  isCodexHeartbeat,
  readCodexSessionMeta,
  readFirstLine,
  withCodexPromptSource,
} from "./codex-prompt-source";

const FIXTURES = resolve(__dirname, "../../fixtures/codex");

/** A recorded `UserPromptSubmit` payload. */
function hook(name: string): Record<string, unknown> {
  const path = join(FIXTURES, "hooks", `UserPromptSubmit-${name}.json`);
  const fixture = JSON.parse(readFileSync(path, "utf8")) as {
    stdin: Record<string, unknown>;
  };
  return fixture.stdin;
}

/** The path of a recorded rollout head. */
function rollout(name: string): string {
  return join(FIXTURES, "rollout", `${name}.jsonl`);
}

/** A typed payload whose `transcript_path` names `rollout(name)`. */
function typedIn(name: string): Record<string, unknown> {
  return { ...hook("typed"), transcript_path: rollout(name) };
}

const TYPED = { prompt_source: "typed", prompt_origin: { kind: "human" } };

describe("codexPromptSource", () => {
  it("gives a prompt typed into the TUI or Codex Desktop the person value", () => {
    for (const name of ["cli-typed", "desktop-typed"]) {
      expect(
        codexPromptSource(hook("typed"), readCodexSessionMeta(rollout(name))),
      ).toEqual(TYPED);
    }
  });

  it("marks a prompt from `codex exec` as sent by a program", () => {
    expect(
      codexPromptSource(hook("typed"), readCodexSessionMeta(rollout("exec"))),
    ).toEqual({ prompt_source: "sdk" });
  });

  it("marks a prompt from Codex as an MCP server as sent by a program", () => {
    expect(codexPromptSource(hook("typed"), { source: "mcp" })).toEqual({
      prompt_source: "sdk",
    });
  });

  it("marks a prompt a parent agent sent its subagent, whatever the thread", () => {
    const meta = readCodexSessionMeta(rollout("subagent"));
    expect(codexPromptSource(hook("subagent"), meta)).toEqual({
      prompt_source: "system",
      prompt_origin: { kind: "coordinator" },
    });
    // The payload's own agent id decides, even in a thread a person started.
    expect(
      codexPromptSource(
        hook("subagent"),
        readCodexSessionMeta(rollout("cli-typed")),
      ),
    ).toEqual({
      prompt_source: "system",
      prompt_origin: { kind: "coordinator" },
    });
  });

  it("marks a heartbeat automation's prompt in a thread a person started", () => {
    expect(
      codexPromptSource(
        hook("heartbeat"),
        readCodexSessionMeta(rollout("desktop-typed")),
      ),
    ).toEqual({
      prompt_source: "system",
      prompt_origin: { kind: "heartbeat" },
    });
  });

  it("leaves the sender absent where Codex records none", () => {
    // No rollout to read.
    expect(codexPromptSource(hook("typed"), undefined)).toBeUndefined();
    // A Codex older than `thread_source`.
    expect(
      codexPromptSource(
        hook("typed"),
        readCodexSessionMeta(rollout("desktop-no-thread-source")),
      ),
    ).toBeUndefined();
    // A subagent Codex runs itself, with no agent id in the payload.
    const guardian = readCodexSessionMeta(rollout("guardian"));
    expect(codexPromptSource(hook("typed"), guardian)).toBeUndefined();
    // A surface this mapping does not know.
    expect(
      codexPromptSource(hook("typed"), {
        source: "custom_surface",
        thread_source: "user",
      }),
    ).toBeUndefined();
  });
});

describe("isCodexHeartbeat", () => {
  it("knows a heartbeat document by its tag and its automation id", () => {
    expect(isCodexHeartbeat(hook("heartbeat")["prompt"] as string)).toBe(true);
    expect(isCodexHeartbeat("  <heartbeat>\n<automation_id>a</automation_id>"))
      .toBe(true);
  });

  it("does not take a prompt that only mentions the tag for one", () => {
    expect(isCodexHeartbeat("why does <heartbeat> fire twice?")).toBe(false);
    expect(isCodexHeartbeat("<heartbeat>no automation named</heartbeat>")).toBe(
      false,
    );
  });
});

describe("readCodexSessionMeta", () => {
  it("reads the source and thread source off the rollout's first line", () => {
    expect(readCodexSessionMeta(rollout("exec"))).toEqual({
      source: "exec",
      thread_source: "user",
    });
    expect(readCodexSessionMeta(rollout("subagent"))?.thread_source).toBe(
      "subagent",
    );
  });

  it("reads nothing from a missing, empty, or foreign file", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-meta-"));
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    const foreign = join(dir, "foreign.jsonl");
    writeFileSync(foreign, '{"type":"event_msg","payload":{}}\n');
    const broken = join(dir, "broken.jsonl");
    writeFileSync(broken, '{"type":"session_meta","payload":\n');
    expect(readCodexSessionMeta(join(dir, "missing.jsonl"))).toBeUndefined();
    expect(readCodexSessionMeta(empty)).toBeUndefined();
    expect(readCodexSessionMeta(foreign)).toBeUndefined();
    expect(readCodexSessionMeta(broken)).toBeUndefined();
  });
});

describe("readFirstLine", () => {
  it("reads the first line only, across read chunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-line-"));
    const path = join(dir, "rollout.jsonl");
    const long = "x".repeat(150 * 1024);
    writeFileSync(path, `${long}\nsecond\n`);
    expect(readFirstLine(path)).toBe(long);
  });

  it("reads a file with no line break whole, and gives up past the bound", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-line-"));
    const short = join(dir, "short.jsonl");
    writeFileSync(short, "only");
    expect(readFirstLine(short)).toBe("only");
    const huge = join(dir, "huge.jsonl");
    writeFileSync(huge, "y".repeat(CODEX_SESSION_META_MAX_BYTES + 1));
    expect(readFirstLine(huge)).toBeUndefined();
  });
});

describe("withCodexPromptSource", () => {
  it("adds the sender to a prompt payload, reading the rollout it names", () => {
    expect(withCodexPromptSource(typedIn("cli-typed"))).toEqual({
      ...typedIn("cli-typed"),
      ...TYPED,
    });
    expect(withCodexPromptSource(typedIn("exec"))).toEqual({
      ...typedIn("exec"),
      prompt_source: "sdk",
    });
  });

  it("reads no rollout when the payload names the sender", () => {
    const reads: string[] = [];
    const readMeta = (path: string) => {
      reads.push(path);
      return undefined;
    };
    expect(withCodexPromptSource(hook("heartbeat"), readMeta)).toMatchObject({
      prompt_source: "system",
      prompt_origin: { kind: "heartbeat" },
    });
    expect(withCodexPromptSource(hook("subagent"), readMeta)).toMatchObject({
      prompt_source: "system",
      prompt_origin: { kind: "coordinator" },
    });
    expect(reads).toEqual([]);
  });

  it("leaves a payload with no recorded sender as it is", () => {
    const noTranscript = hook("no-transcript");
    expect(withCodexPromptSource(noTranscript)).toBe(noTranscript);
    // The fixture's own path names a rollout this machine does not have.
    const missing = hook("typed");
    expect(withCodexPromptSource(missing)).toBe(missing);
    const legacy = typedIn("desktop-no-thread-source");
    expect(withCodexPromptSource(legacy)).toBe(legacy);
  });

  it("touches no other event, and keeps a sender the payload already names", () => {
    const pre = {
      session_id: "s",
      hook_event_name: "PreToolUse",
      transcript_path: rollout("cli-typed"),
    };
    expect(withCodexPromptSource(pre)).toBe(pre);
    const named = { ...typedIn("exec"), prompt_source: "typed" };
    expect(withCodexPromptSource(named)).toBe(named);
    expect(withCodexPromptSource("not a payload")).toBe("not a payload");
  });

  it("gives each payload its own origin object", () => {
    const first = withCodexPromptSource(typedIn("cli-typed")) as {
      prompt_origin: { kind: string };
    };
    first.prompt_origin.kind = "changed";
    expect(withCodexPromptSource(typedIn("cli-typed"))).toMatchObject(TYPED);
  });
});
