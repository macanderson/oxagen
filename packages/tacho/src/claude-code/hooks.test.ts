import { describe, expect, it } from "vitest";
import { digestBytes } from "../digest";
import { redactionMarker } from "../evidence/redaction";
import { MAX_CONTENT_REDACTIONS } from "../envelope";
import { normalizeHook } from "./hooks";
import { type RecorderOptions, SessionRecorder } from "./recorder";

const SESSION = "00000000-0000-4000-8000-000000000001";
const ENV = {
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_EFFORT: "high",
  CLAUDE_PID: "42",
  ANTHROPIC_API_KEY: "sk-secret",
};

function hook(event: string, extra: Record<string, unknown> = {}) {
  return normalizeHook(
    {
      session_id: SESSION,
      hook_event_name: event,
      cwd: "/home/dev/proj",
      transcript_path: "/t.jsonl",
      ...extra,
    },
    ENV,
    { sessionUuid: "11111111-1111-4111-8111-111111111111" },
  );
}

describe("hook normalization", () => {
  it("tolerates both spellings of the drifting fields", () => {
    expect(hook("SessionStart", { trigger: "resume" })[0]).toMatchObject({
      kind: "agent_start",
      hook_source_kind: "resume",
    });
    expect(
      hook("SessionStart", { source: "fork", model: "claude-opus-5" })[0]?.body,
    ).toMatchObject({ session_start_source: "fork", model: "claude-opus-5" });
    expect(hook("SessionEnd", { end_reason: "logout" })[0]?.body).toMatchObject(
      { session_end_reason: "logout", session_outcome: "aborted" },
    );
    expect(hook("SessionEnd", { reason: "clear" })[0]?.body).toMatchObject({
      session_outcome: "completed",
    });
    expect(
      hook("UserPromptSubmit", {
        user_input: "hello",
        command_name: "review",
        command_input: "src",
      })[0]?.body,
    ).toMatchObject({
      prompt_length: 5,
      command_name: "review",
    });
    expect(
      hook("StopFailure", {
        error_type: "rate_limit",
        last_assistant_message: "x",
      })[0]?.body,
    ).toMatchObject({ stop_failure_error_type: "rate_limit" });
    expect(
      hook("StopFailure", { error: "billing_error" })[0]?.body,
    ).toMatchObject({ api_error_class: "billing_error" });
  });

  it("keeps unpromoted members in attrs and never the environment secrets", () => {
    const [draft] = hook("SessionStart", {
      source: "startup",
      brand_new_member: { nested: 1 },
    });
    expect(draft?.attrs).toEqual({ "hook.brand_new_member": '{"nested":1}' });
    expect(JSON.stringify(draft)).not.toContain("sk-secret");
    expect(draft?.host).toMatchObject({ claude_pid: 42 });
    expect(draft?.context).toMatchObject({
      entrypoint: "cli",
      effort: "high",
      cwd: "/home/dev/proj",
    });
  });

  it("maps the tool events, including failures, batches, permissions, and denials", () => {
    const pre = hook("PreToolUse", {
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/x" },
      tool_use_id: "toolu_1",
    })[0];
    expect(pre).toMatchObject({
      kind: "tool_requested",
      body: {
        tool_name: "Bash",
        effect_kind: "command",
        tool_target: "rm -rf /tmp/x",
        tool_is_mutating: true,
      },
    });
    expect((pre?.body as Record<string, unknown>)["effect_id"]).toMatch(
      /^eff_/,
    );

    const failed = hook("PostToolUseFailure", {
      tool_name: "Read",
      tool_input: { file_path: "/x" },
      tool_use_id: "toolu_2",
      error: "ENOENT: no such file",
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]?.body).toMatchObject({
      tool_status: "error",
      tool_error_class: "ENOENT",
    });

    const objectError = hook("PostToolUseFailure", {
      tool_name: "Read",
      tool_use_id: "toolu_2b",
      error: { code: 1 },
    });
    expect(objectError[0]?.body).toMatchObject({ tool_status: "error" });

    const write = hook("PostToolUse", {
      tool_name: "Write",
      tool_input: { file_path: "/x.txt", content: "a" },
      tool_use_id: "toolu_3",
      tool_response: { ok: true },
      duration_ms: 3,
    });
    expect(write.map((d) => d.kind)).toEqual(["tool_call", "file_io"]);
    expect(write[0]?.body).toMatchObject({
      tool_output_bytes: 11,
      tool_duration_ms: 3,
    });

    const fetch = hook("PostToolUse", {
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/a" },
      tool_use_id: "toolu_4",
    });
    expect(fetch.map((d) => d.kind)).toEqual(["tool_call", "network"]);
    expect(fetch[1]?.body).toMatchObject({ tool_target: "example.com" });

    const batch = hook("PostToolBatch", {
      tool_calls: [
        { tool_name: "Read", tool_use_id: "a", succeeded: true },
        { tool_name: "Edit", tool_use_id: "b", succeeded: false },
      ],
    });
    expect(batch).toHaveLength(2);
    expect(batch[1]?.body).toMatchObject({
      batch_size: 2,
      batch_index: 1,
      tool_status: "error",
    });

    expect(
      hook("PermissionRequest", {
        tool_name: "Bash",
        tool_input: { command: "git push" },
        tool_use_id: "toolu_5",
      })[0],
    ).toMatchObject({
      kind: "approval_request",
      body: { policy_decision: "ask", policy_source: "harness" },
    });
    expect(
      hook("PermissionDenied", {
        tool_name: "Bash",
        tool_input: {},
        tool_use_id: "toolu_6",
      })[0]?.body,
    ).toMatchObject({ policy_decision: "deny", tool_decision: "reject" });
  });

  it("seals a git commit, a git push, and a pull request as their own frames", () => {
    const push = hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git push --force-with-lease origin HEAD:main" },
      tool_use_id: "toolu_git_1",
    });
    expect(push.map((d) => d.kind)).toEqual(["tool_call", "command"]);
    expect(push[1]?.body).toMatchObject({
      effect_kind: "git_push",
      tool_status: "ok",
      tool_target: "git push --force-with-lease origin HEAD:main",
    });
    expect((push[1]?.body as Record<string, unknown>)["effect_id"]).toMatch(
      /^eff_/,
    );

    const commit = hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "wire the git effects"' },
      tool_use_id: "toolu_git_2",
    });
    expect(commit.map((d) => d.kind)).toEqual(["tool_call", "command"]);
    expect(commit[1]?.body).toMatchObject({ effect_kind: "git_commit" });

    const shellPr = hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "gh pr create --fill" },
      tool_use_id: "toolu_git_3",
    });
    expect(shellPr.map((d) => d.kind)).toEqual(["tool_call", "command"]);
    expect(shellPr[1]?.body).toMatchObject({ effect_kind: "pr_open" });

    const mcpPr = hook("PostToolUse", {
      tool_name: "mcp__github__create_pull_request",
      tool_input: { title: "x" },
      tool_use_id: "toolu_git_4",
    });
    expect(mcpPr.map((d) => d.kind)).toEqual(["tool_call", "network"]);
    expect(mcpPr[1]?.body).toMatchObject({
      effect_kind: "pr_open",
      mcp_tool_name: "create_pull_request",
    });

    const failedPush = hook("PostToolUseFailure", {
      tool_name: "Bash",
      tool_input: { command: "git push" },
      tool_use_id: "toolu_git_5",
      error: "rejected: non-fast-forward",
    });
    expect(failedPush.map((d) => d.kind)).toEqual(["tool_call"]);

    const status = hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_use_id: "toolu_git_6",
    });
    expect(status[1]?.body).toMatchObject({ effect_kind: "command" });
  });

  it("maps the lifecycle, context, and collaboration events", () => {
    expect(hook("Setup", { trigger: "maintenance" })[0]?.body).toEqual({
      setup_trigger: "maintenance",
    });
    expect(
      hook("InstructionsLoaded", {
        file_path: "/CLAUDE.md",
        memory_type: "Project",
        load_reason: "nested_traversal",
      })[0]?.body,
    ).toMatchObject({ instructions_memory_type: "Project" });
    expect(hook("UserPromptExpansion", { prompt: "/review" })[0]?.kind).toBe(
      "oxagen:message",
    );
    expect(
      hook("Stop", {
        last_assistant_message: "done",
        stop_hook_active: true,
        background_tasks: [],
        session_crons: [],
      })[0]?.body,
    ).toMatchObject({ stop_hook_active: true, background_tasks: [] });
    expect(
      hook("SubagentStart", {
        agent_id: "ag1",
        agent_type: "Explore",
        tool_use_id: "toolu_7",
      })[0],
    ).toMatchObject({
      kind: "subagent_start",
      subagent: { subagent_id: "ag1", subagent_type: "Explore" },
    });
    expect(
      hook("SubagentStop", {
        agent_id: "ag1",
        agent_type: "Explore",
        last_assistant_message: "r",
        agent_transcript_path: "/a.jsonl",
      })[0]?.body,
    ).toMatchObject({
      subagent_transcript_path: "/a.jsonl",
      tool_status: "ok",
    });
    expect(
      hook("MessageDisplay", {
        delta: "hi",
        index: 2,
        final: false,
        message_id: "m1",
        turn_id: "t1",
      })[0],
    ).toMatchObject({
      body: {
        response_length: 2,
        message_index: 2,
        message_final: false,
        message_uuid: "m1",
      },
      turn: { turn_id: "t1" },
    });
    expect(
      hook("PreCompact", {
        trigger: "auto",
        custom_instructions: "keep tests",
      })[0],
    ).toMatchObject({
      kind: "oxagen:compaction",
      hook_source_kind: "PreCompact:auto",
    });
    expect(hook("PostCompact", {})[0]?.hook_source_kind).toBe(
      "PostCompact:unknown",
    );
    expect(
      hook("PreModelSwitch", { from_model: "a", to_model: "b" })[0]?.body,
    ).toMatchObject({
      model_from: "a",
      model_to: "b",
      model_switch_reason: "PreModelSwitch",
    });
    expect(
      hook("Notification", { notification_type: "permission_prompt" })[0],
    ).toMatchObject({ hook_source_kind: "permission_prompt" });
    expect(hook("Notification", { type: "idle_prompt" })[0]?.body).toEqual({
      notification_type: "idle_prompt",
    });
    expect(
      hook("TaskCreated", { task_name: "Write tests", task_id: "3" })[0]?.body,
    ).toEqual({ task_name: "Write tests", task_id: "3" });
    expect(
      hook("ConfigChange", {
        file_path: "/s.json",
        config_source: "user_settings",
      })[0]?.body,
    ).toMatchObject({ config_source: "user_settings" });
    expect(
      hook("ConfigChange", { source: "policy_settings" })[0]?.body,
    ).toEqual({ config_source: "policy_settings" });
    expect(
      hook("CwdChanged", { previous_cwd: "/a", new_cwd: "/b" })[0]?.body,
    ).toEqual({ cwd_previous: "/a", cwd_new: "/b" });
    expect(
      hook("DirectoryAdded", {
        directory: "/c",
        add_method: "slash_command",
      })[0]?.body,
    ).toEqual({ directory_added: "/c", directory_add_method: "slash_command" });
    expect(hook("FileChanged", { file_path: "/.env" })[0]?.body).toEqual({
      file_changed_path: "/.env",
    });
    const worktree = hook("WorktreeCreate", {
      worktree_path: "/wt",
      reason: "isolation",
    })[0];
    expect(worktree?.body).toEqual({ worktree_reason: "isolation" });
    expect(worktree?.context).toMatchObject({ worktree_path: "/wt" });
    expect(
      hook("Elicitation", {
        server_name: "srv",
        elicitation_prompt: "p",
        message_type: "text",
      })[0]?.body,
    ).toMatchObject({
      elicitation_server: "srv",
      elicitation_message_type: "text",
    });
    expect(
      hook("ElicitationResult", {
        server_name: "srv",
        elicitation_prompt: "p",
        user_response: "yes",
      })[0]?.body,
    ).toHaveProperty("elicitation_response_digest");
    expect(hook("TeammateIdle", { teammate_name: "bob" })[0]?.body).toEqual({
      teammate_name: "bob",
    });
    expect(hook("SomethingNew", { payload: 1 })[0]).toMatchObject({
      kind: "oxagen:notification",
      body: { notification_type: "SomethingNew" },
      attrs: { "hook.payload": "1" },
    });
  });

  it("refuses a payload without a session id", () => {
    expect(() =>
      normalizeHook({ hook_event_name: "Stop" }, {}, { sessionUuid: "x" }),
    ).toThrow();
  });
});

describe("content on a prompt frame", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";

  it("chains a digest of the redacted prompt and names what was cut", () => {
    const draft = hook("UserPromptSubmit", {
      prompt: `ship it with ${secret}`,
    })[0];

    // What a body would carry, and what the control plane verifies it
    // against. The two have to agree or no body can ever be accepted.
    expect(draft?.content_digest).toBe(
      digestBytes(`ship it with ${redactionMarker("github_token")}`),
    );
    expect(draft?.content_redactions?.map((r) => r.reason)).toEqual([
      "github_token",
    ]);
    // The body member keeps digesting the prompt as the harness reported it:
    // it correlates frames and is never verified against bytes.
    expect(draft?.body["prompt_digest"]).not.toBe(draft?.content_digest);
  });

  it("records no redaction for a clean prompt", () => {
    const draft = hook("UserPromptSubmit", { prompt: "ship it" })[0];
    expect(draft?.content_digest).toBe(digestBytes("ship it"));
    expect(draft?.content_redactions).toBeUndefined();
  });
});

describe("a prompt with more credentials than the envelope records", () => {
  // Redaction removes every match. The record of the matches is what is
  // bounded: `contentSchema` caps `content.redactions`, and before this the
  // draft handed over all of them, so a prompt pasting a long list of tokens
  // failed to seal. The daemon answered 500, the hook fell back to a local
  // decision, and the turn lost the frame it was supposed to leave behind.
  const many = Array.from(
    { length: MAX_CONTENT_REDACTIONS + 44 },
    (_, i) => `ghp_${String(i).padStart(36, "a")}`,
  );

  it("redacts every one, records the cap, and says how many there were", () => {
    const draft = hook("UserPromptSubmit", { prompt: many.join(" ") })[0];

    expect(draft?.content_redactions).toHaveLength(MAX_CONTENT_REDACTIONS);
    expect(draft?.attrs["oxagen.content_redactions_total"]).toBe(
      String(many.length),
    );
    // Not one token survives in the bytes a body would carry.
    const carried = new TextDecoder().decode(
      draft?.content_bytes ?? new Uint8Array(),
    );
    expect(carried).not.toContain("ghp_");
    expect(draft?.content_digest).toBe(digestBytes(carried));
  });

  it("seals, which is the whole point", () => {
    const recorder = new SessionRecorder({
      context: {
        agent: {
          agent_key: "acme.core.cc-laptop",
          fleet_id: "wrk_test",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
          host_enrollment_id: "he_0000000000000000000000000000",
        },
      },
      harnessSessionId: SESSION,
      scope: "he_0000000000000000000000000000",
    });
    const events = recorder.ingestHook(
      {
        session_id: SESSION,
        hook_event_name: "UserPromptSubmit",
        cwd: "/home/dev/proj",
        transcript_path: "/t.jsonl",
        prompt: many.join(" "),
      },
      ENV,
    );
    expect(events.map((e) => e.kind)).toContain("turn_start");
  });

  it("keeps the unpromoted hook fields next to the count", () => {
    const draft = hook("UserPromptSubmit", {
      prompt: many.join(" "),
      some_new_upstream_field: "kept",
    })[0];
    expect(draft?.attrs["hook.some_new_upstream_field"]).toBe("kept");
    expect(draft?.attrs["oxagen.content_redactions_total"]).toBeDefined();
  });
});

describe("a body sink that cannot write", () => {
  const recorderWith = (
    onContentBody?: RecorderOptions["onContentBody"],
  ): SessionRecorder =>
    new SessionRecorder({
      context: {
        agent: {
          agent_key: "acme.core.cc-laptop",
          fleet_id: "wrk_test",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
          host_enrollment_id: "he_0000000000000000000000000000",
        },
      },
      harnessSessionId: SESSION,
      scope: "he_0000000000000000000000000000",
      ...(onContentBody !== undefined ? { onContentBody } : {}),
    });

  const twoPrompts = (recorder: SessionRecorder) => {
    const go = () =>
      recorder.ingestHook(
        {
          session_id: SESSION,
          hook_event_name: "UserPromptSubmit",
          cwd: "/home/dev/proj",
          transcript_path: "/t.jsonl",
          prompt: "deploy the fix",
        },
        ENV,
      );
    return [...go(), ...go()];
  };

  it("leaves the chain exactly as it would be with no sink at all", () => {
    // `seal` advances the cursor before the caller appends the event. A sink
    // that threw here would take the event with it, and the next hook would
    // record a sequence number nothing explains: a chain break the control
    // plane reports for the rest of the session, caused by a full disk.
    const quiet = twoPrompts(recorderWith());
    const failing = twoPrompts(
      recorderWith(() => {
        throw Object.assign(new Error("no space left on device"), {
          code: "ENOSPC",
        });
      }),
    );

    expect(failing.map((e) => `${e.kind}#${e.seq}`)).toEqual(
      quiet.map((e) => `${e.kind}#${e.seq}`),
    );
    // The frame still carries its digest, so the missing body is a gap the
    // seal records rather than an event that never existed.
    expect(failing[0]?.content?.digest).toBe(quiet[0]?.content?.digest);
    expect(failing[0]?.content?.digest).toBeDefined();
  });
});
