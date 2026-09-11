/**
 * The Claude Code settings writer (spec section 5.4 and 5.5). Pure functions
 * over the parsed settings document: merge Tacho's hook entries and env block
 * in, strip them out, or report which are present. Entries are recognised by
 * the enrollment id carried in the hook command or URL, so the writer never
 * needs a foreign key in the document and never touches an entry it did not
 * write.
 */

/** Enforcement events run `tacho-hook` as a command hook (fail closed). */
export const COMMAND_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "Stop",
] as const;

/** Telemetry-only events post straight to the daemon (fail open, gap chained). */
export const HTTP_HOOK_EVENTS = [
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionDenied",
  "Notification",
  "ConfigChange",
  "SessionEnd",
  "InstructionsLoaded",
  "UserPromptExpansion",
  "MessageDisplay",
  "StopFailure",
  "TaskCreated",
  "TaskCompleted",
  "TeammateIdle",
  "CwdChanged",
  "DirectoryAdded",
  "Elicitation",
  "ElicitationResult",
  "FileChanged",
  "PreModelSwitch",
  "PostModelSwitch",
  "Setup",
  "WorktreeCreate",
  "WorktreeRemove",
] as const;

export const ALL_HOOK_EVENTS = [
  ...COMMAND_HOOK_EVENTS,
  ...HTTP_HOOK_EVENTS,
] as const;

export type HookEventName = (typeof ALL_HOOK_EVENTS)[number];

const COMMAND_TIMEOUTS_S: Record<(typeof COMMAND_HOOK_EVENTS)[number], number> =
  {
    SessionStart: 10,
    UserPromptSubmit: 10,
    PreToolUse: 15,
    PermissionRequest: 600,
    Stop: 10,
  };

const HTTP_TIMEOUT_S = 5;

export const TACHO_LOCAL_TOKEN_ENV = "TACHO_LOCAL_TOKEN";
export const TACHO_ENROLLMENT_ENV = "TACHO_ENROLLMENT";

export interface HookInstallConfig {
  enrollmentId: string;
  /** Shell command that runs `tacho-hook`; the writer appends its flags. */
  hookCommand: string;
  /** The daemon's loopback port. */
  port: number;
  /** The per-install bearer the loopback listener requires. */
  localToken: string;
  /** Path to `TACHO_HOME` when it is not the default, exported to hooks. */
  tachoHome?: string;
}

export interface HookEntry {
  type: "command" | "http";
  command?: string;
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
  [key: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
  [key: string]: unknown;
}

export type SettingsDocument = Record<string, unknown> & {
  hooks?: Record<string, HookGroup[]>;
  env?: Record<string, string>;
};

export function hookMarker(enrollmentId: string): string {
  return `--enrollment ${enrollmentId}`;
}

export function hookUrl(port: number, enrollmentId: string): string {
  return `http://127.0.0.1:${port}/hook/${enrollmentId}`;
}

function isTachoEntry(entry: HookEntry, enrollmentId?: string): boolean {
  const idPattern = enrollmentId ?? "tch_[a-z0-9]{22}";
  if (entry.type === "command" && typeof entry.command === "string") {
    return new RegExp(`--enrollment ${idPattern}(\\s|$)`).test(entry.command);
  }
  if (entry.type === "http" && typeof entry.url === "string") {
    return new RegExp(`/hook/${idPattern}$`).test(entry.url);
  }
  return false;
}

function isTachoGroup(group: HookGroup, enrollmentId?: string): boolean {
  return (
    Array.isArray(group.hooks) &&
    group.hooks.length > 0 &&
    group.hooks.every((entry) => isTachoEntry(entry, enrollmentId))
  );
}

/** The hook groups Tacho installs, by event. */
export function tachoHookEntries(
  config: HookInstallConfig,
): Record<HookEventName, HookGroup[]> {
  const out = {} as Record<HookEventName, HookGroup[]>;
  for (const event of COMMAND_HOOK_EVENTS) {
    out[event] = [
      {
        hooks: [
          {
            type: "command",
            command: `${config.hookCommand} ${hookMarker(config.enrollmentId)}`,
            timeout: COMMAND_TIMEOUTS_S[event],
          },
        ],
      },
    ];
  }
  for (const event of HTTP_HOOK_EVENTS) {
    out[event] = [
      {
        hooks: [
          {
            type: "http",
            url: hookUrl(config.port, config.enrollmentId),
            headers: { Authorization: `Bearer $${TACHO_LOCAL_TOKEN_ENV}` },
            allowedEnvVars: [TACHO_LOCAL_TOKEN_ENV],
            timeout: HTTP_TIMEOUT_S,
          },
        ],
      },
    ];
  }
  return out;
}

/** The env block that turns on Claude Code's OpenTelemetry export toward the daemon. */
export function tachoEnv(config: HookInstallConfig): Record<string, string> {
  return {
    [TACHO_ENROLLMENT_ENV]: config.enrollmentId,
    [TACHO_LOCAL_TOKEN_ENV]: config.localToken,
    ...(config.tachoHome !== undefined ? { TACHO_HOME: config.tachoHome } : {}),
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${config.port}`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${config.localToken}`,
    OTEL_LOG_TOOL_DETAILS: "1",
    OTEL_LOGS_EXPORT_INTERVAL: "5000",
    OTEL_METRIC_EXPORT_INTERVAL: "10000",
  };
}

export const TACHO_ENV_KEYS = Object.keys(
  tachoEnv({ enrollmentId: "x", hookCommand: "x", port: 1, localToken: "x" }),
).concat("TACHO_HOME");

export interface MergeResult {
  settings: SettingsDocument;
  changed: boolean;
  /** Env values the merge overwrote, so `unenroll` can restore them. */
  displaced: Record<string, string>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Merge Tacho's entries into a settings document. Idempotent: a second call
 * with the same config changes nothing. Foreign groups on the same events
 * are kept; earlier Tacho groups for the same enrollment are replaced.
 */
export function mergeTachoSettings(
  existing: unknown,
  config: HookInstallConfig,
): MergeResult {
  const settings: SettingsDocument =
    existing !== null && typeof existing === "object"
      ? clone(existing as SettingsDocument)
      : {};
  const before = JSON.stringify(settings);
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, groups] of Object.entries(tachoHookEntries(config))) {
    const foreign = (hooks[event] ?? []).filter(
      (group) => !isTachoGroup(group, config.enrollmentId),
    );
    hooks[event] = [...foreign, ...groups];
  }
  settings.hooks = hooks;
  const env = { ...(settings.env ?? {}) };
  const displaced: Record<string, string> = {};
  for (const [key, value] of Object.entries(tachoEnv(config))) {
    const previous = env[key];
    if (
      previous !== undefined &&
      previous !== value &&
      !isTachoEnvValue(key, previous)
    ) {
      displaced[key] = previous;
    }
    env[key] = value;
  }
  settings.env = env;
  return { settings, changed: JSON.stringify(settings) !== before, displaced };
}

const STATIC_TACHO_ENV: Record<string, string> = Object.fromEntries(
  Object.entries(
    tachoEnv({ enrollmentId: "x", hookCommand: "x", port: 1, localToken: "x" }),
  ).filter(
    ([key]) =>
      ![
        TACHO_ENROLLMENT_ENV,
        TACHO_LOCAL_TOKEN_ENV,
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_HEADERS",
      ].includes(key),
  ),
);

/** Does this env value look like one Tacho wrote (so removing it is safe)? */
function isTachoEnvValue(key: string, value: string): boolean {
  if (key === TACHO_ENROLLMENT_ENV) return /^tch_[a-z0-9]{22}$/.test(value);
  if (key === TACHO_LOCAL_TOKEN_ENV || key === "TACHO_HOME") return true;
  if (key === "OTEL_EXPORTER_OTLP_ENDPOINT")
    return /^http:\/\/127\.0\.0\.1:\d+$/.test(value);
  if (key === "OTEL_EXPORTER_OTLP_HEADERS")
    return value.startsWith("Authorization=Bearer ");
  return STATIC_TACHO_ENV[key] === value;
}

export interface StripResult {
  settings: SettingsDocument;
  changed: boolean;
}

/**
 * Remove Tacho's entries (for one enrollment, or any when omitted) and its
 * env keys, restoring displaced values. Every foreign entry survives.
 */
export function stripTachoSettings(
  existing: unknown,
  enrollmentId?: string,
  restore: Record<string, string> = {},
): StripResult {
  const settings: SettingsDocument =
    existing !== null && typeof existing === "object"
      ? clone(existing as SettingsDocument)
      : {};
  const before = JSON.stringify(settings);
  if (settings.hooks !== undefined) {
    const hooks: Record<string, HookGroup[]> = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const kept = groups.filter((group) => !isTachoGroup(group, enrollmentId));
      if (kept.length > 0) hooks[event] = kept;
    }
    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    else delete settings.hooks;
  }
  if (settings.env !== undefined) {
    const env = { ...settings.env };
    for (const key of TACHO_ENV_KEYS) {
      const value = env[key];
      if (value === undefined) continue;
      if (key in restore) {
        env[key] = restore[key] as string;
      } else if (isTachoEnvValue(key, value)) {
        delete env[key];
      }
    }
    if (Object.keys(env).length > 0) settings.env = env;
    else delete settings.env;
  }
  return { settings, changed: JSON.stringify(settings) !== before };
}

export interface HookPresence {
  /** Every expected event has exactly the Tacho group installed. */
  complete: boolean;
  present: HookEventName[];
  missing: HookEventName[];
  envOk: boolean;
  disabledByFlag: boolean;
}

/** Which of Tacho's hooks are installed for this enrollment. */
export function tachoHookPresence(
  existing: unknown,
  enrollmentId: string,
): HookPresence {
  const settings =
    existing !== null && typeof existing === "object"
      ? (existing as SettingsDocument)
      : {};
  const present: HookEventName[] = [];
  const missing: HookEventName[] = [];
  for (const event of ALL_HOOK_EVENTS) {
    const groups = settings.hooks?.[event] ?? [];
    if (groups.some((group) => isTachoGroup(group, enrollmentId))) {
      present.push(event);
    } else {
      missing.push(event);
    }
  }
  const env = settings.env ?? {};
  const envOk =
    env[TACHO_ENROLLMENT_ENV] === enrollmentId &&
    typeof env[TACHO_LOCAL_TOKEN_ENV] === "string" &&
    env["CLAUDE_CODE_ENABLE_TELEMETRY"] === "1";
  const disabledByFlag = settings["disableAllHooks"] === true;
  return {
    complete: missing.length === 0 && envOk && !disabledByFlag,
    present,
    missing,
    envOk,
    disabledByFlag,
  };
}

/** The managed settings document for MDM distribution (spec section 5.5). */
export function renderManagedSettings(
  config: HookInstallConfig,
): SettingsDocument {
  return {
    ...mergeTachoSettings({}, config).settings,
    allowManagedHooksOnly: true,
    disableBypassPermissionsMode: "disable",
  };
}
