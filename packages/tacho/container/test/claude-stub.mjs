#!/usr/local/bin/node
// A stand-in for Claude Code in the Docker test (never shipped). It reads the
// managed settings the launcher wrote read-only, runs the hook command they
// name exactly as Claude Code would, and runs each command the hook allows.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const settings = JSON.parse(
  readFileSync("/etc/claude-code/managed-settings.json", "utf8"),
);
const SESSION = "00000000-0000-4000-8000-000000000001";
function hook(event, payload) {
  const command = settings.hooks?.[event]?.[0]?.hooks?.[0]?.command;
  if (typeof command !== "string") return {};
  const result = spawnSync("/bin/sh", ["-c", command], {
    input: JSON.stringify({
      session_id: SESSION,
      transcript_path: "/workspace/.oxagen-contained/transcript.jsonl",
      cwd: "/workspace",
      permission_mode: "default",
      hook_event_name: event,
      ...payload,
    }),
    encoding: "utf8",
  });
  return result.stdout ? JSON.parse(result.stdout) : {};
}

const commands = [
  "curl -sS --max-time 5 https://api.anthropic.com/v1/messages",
  'sh -c "curl -sS --max-time 5 https://api.anthropic.com/v1/messages"',
];
let index = 0;
for (const command of commands) {
  index += 1;
  const tool = {
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: `toolu_stub_${index}`,
  };
  const pre = hook("PreToolUse", tool);
  if (pre.hookSpecificOutput?.permissionDecision === "deny") {
    console.log(
      `DENIED ${index}: ${pre.hookSpecificOutput.permissionDecisionReason}`,
    );
    continue;
  }
  const run = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  if (run.status === 0) {
    hook("PostToolUse", { ...tool, tool_response: { stdout: run.stdout } });
    console.log(`RAN ${index}`);
  } else {
    hook("PostToolUseFailure", { ...tool, error: run.stderr.trim() });
    console.log(`FAILED ${index} (${run.status}): ${run.stderr.trim()}`);
  }
}

// The one exit that works: the model route through the bridge.
const model = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({ model: "stub", max_tokens: 1, messages: [] }),
}).then(
  (response) => response.status,
  (error) => `error ${error.message}`,
);
console.log(`MODEL ${model}`);
hook("Stop", { stop_hook_active: false });
