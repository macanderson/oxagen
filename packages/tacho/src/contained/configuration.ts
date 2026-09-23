import { CODEX_HOOK_EVENTS } from "../host/codex-writer";
import { COMMAND_HOOK_EVENTS } from "../host/settings-writer";
import type { ContainedHarness } from "./profile";

const VALUE_FLAGS = new Set([
  "--model",
  "-m",
  "--max-turns",
  "--max-budget-usd",
  "--output-format",
  "--reasoning-effort",
]);
const BOOLEAN_FLAGS = new Set(["--print", "-p", "--verbose", "--json"]);

/** Headless launch accepts task/output options, never alternate config sources. */
export function validateContainedArguments(
  harness: ContainedHarness,
  args: readonly string[],
): void {
  if (
    args.length > 128 ||
    args.some((arg) => arg.length > 64 * 1024 || arg.includes("\0"))
  )
    throw new Error("Contained command arguments are too large");
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--") return;
    if (!arg.startsWith("-")) {
      if (index === 0 && harness === "codex" && arg === "exec") continue;
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) continue;
    if (VALUE_FLAGS.has(arg)) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("-"))
        throw new Error(`Missing value for ${arg}`);
      index += 1;
      continue;
    }
    throw new Error(
      `Contained execution does not accept ${arg}; configure hooks and network routes through Oxagen`,
    );
  }
}

export function containedConfiguration(
  harness: ContainedHarness,
): Record<string, string> {
  const events =
    harness === "codex"
      ? CODEX_HOOK_EVENTS
      : [
          ...COMMAND_HOOK_EVENTS,
          "PostToolUse",
          "PostToolUseFailure",
          "SessionEnd",
          "SubagentStart",
          "SubagentStop",
          "PreCompact",
          "PostCompact",
        ];
  const hooks = Object.fromEntries(
    [...new Set(events)].map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: "command",
              command: "/usr/local/bin/node /opt/oxagen/hook.mjs",
              timeout: 30,
            },
          ],
        },
      ],
    ]),
  );
  const requirements =
    [
      "allow_managed_hooks_only = true",
      "[features]",
      "hooks = true",
      "[hooks]",
      'managed_dir = "/opt/oxagen"',
      ...CODEX_HOOK_EVENTS.flatMap((event) => [
        `[[hooks.${event}]]`,
        `[[hooks.${event}.hooks]]`,
        'type = "command"',
        'command = "/usr/local/bin/node /opt/oxagen/hook.mjs"',
        "timeout = 30",
      ]),
    ].join("\n") + "\n";
  return {
    "requirements.toml": requirements,
    "settings.json": JSON.stringify({
      hooks,
      disableAllHooks: false,
      allowManagedHooksOnly: true,
    }),
    "hooks.json": JSON.stringify({ hooks }),
    "config.toml":
      [
        'model_provider = "contained"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        'sqlite_home = "/workspace/.oxagen-contained/state"',
        'log_dir = "/workspace/.oxagen-contained/log"',
        "[history]",
        'persistence = "none"',
        "[model_providers.contained]",
        'name = "Oxagen contained gateway"',
        'base_url = "http://127.0.0.1:43801/model/v1"',
        'env_key = "OXAGEN_CONTAINED_ROUTE"',
        'wire_api = "responses"',
        "[features]",
        "shell_snapshot = false",
      ].join("\n") + "\n",
  };
}
