/**
 * What `tacho-hook` does (spec section 5.4): read the hook payload from
 * stdin, hand it to the daemon over the Unix socket inside a tight budget,
 * and print the daemon's answer. When the daemon does not answer, decide
 * from the cached bundle, spool the event for replay, and answer anyway, so
 * enforcement never depends on the daemon being up.
 */
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  evaluatePreToolUse,
  type Evaluation,
  type MatchContext,
  verifyBundle,
} from "../host/bundle";
import {
  ensureDir,
  readJsonFileIfExists,
  writeSensitiveFileAtomic,
} from "../host/fs";
import {
  type HostFile,
  hostFileSchema,
  hostStatusInForce,
  readHostFile,
} from "../host/host-file";
import type { TachoPaths } from "../host/paths";
import { ulid } from "../ids";
import { toProtocolTimestamp } from "../timestamp";
import {
  customAgentNameProblem,
  hostEnrollmentIdSchema,
  type TachoHarness,
  tachoHarnessSchema,
} from "../wire";
import {
  CODEX_HOOK_EVENTS,
  type CodexHookEventName,
  codexHookTimeoutS,
} from "../host/codex-writer";
import { cursorHookTimeoutS } from "../host/cursor-writer";
import {
  COMMAND_HOOK_TIMEOUTS_S,
  SESSION_END_TIMEOUT_S,
} from "../host/settings-writer";
import {
  STELLA_HOOK_EVENTS,
  type StellaHookEventName,
  stellaHookTimeoutMs,
} from "../host/stella-writer";
import { DEFAULT_SECRET_ENV_PATTERN, snapshotEnv } from "./context";
import {
  cursorAnswer,
  CURSOR_TO_CLAUDE_EVENT,
  type CursorHookEventName,
  translateCursorPayload,
} from "./cursor-adapter";
import { codexHarnessPid } from "./harness-process";
import { hookInputSchema } from "./hooks";
import {
  type PsLookup,
  psStartInstance,
  resolveStellaIdentity,
  type StellaIdentity,
  stellaAnswer,
  stellaHarnessPid,
  translateStellaPayload,
  tryParseAnswerBody,
} from "./stella-adapter";

/** The `--harness <name>` flag on the hook command; unknown names default to Claude Code. */
/**
 * What Cursor shows when a hook payload cannot be read. It names the cause
 * and the repair rather than saying only that something was denied, because
 * the person seeing it did nothing wrong and can act on it.
 */
/**
 * Refuse a Cursor hook whose payload could not be parsed, in the shape the
 * event it names actually reads.
 *
 * `cursorAnswer` does this from a parsed event. Here the parse is what
 * failed, so the event comes off the raw payload defensively, and a payload
 * that does not name one is answered in both shapes.
 */
function cursorRefusal(raw: unknown, message: string): string {
  const named =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)["hook_event_name"]
      : undefined;
  const claudeEvent =
    typeof named === "string" && named in CURSOR_TO_CLAUDE_EVENT
      ? CURSOR_TO_CLAUDE_EVENT[named as CursorHookEventName]
      : undefined;
  if (claudeEvent !== undefined)
    return cursorAnswer(
      {
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      },
      claudeEvent,
    );
  return `${JSON.stringify({
    permission: "deny",
    continue: false,
    user_message: message,
    agent_message: message,
  })}\n`;
}

const CURSOR_UNREADABLE_PAYLOAD =
  "Oxagen could not read this hook payload, so it cannot say what this agent is permitted to do. Run `tacho status` and check that the wrapper matches this version of Cursor.";

const UNREADABLE_ENROLLMENT =
  "Oxagen cannot read this machine's enrollment, so it cannot say what this agent is permitted to do. Run `tacho status` to repair it.";

/**
 * The fields that route a hook to the daemon. A `host.json` the full schema
 * rejects usually still has them: the likeliest cause is version skew, a
 * newer daemon caching a bundle with a field this binary's strict bundle
 * schema does not know, and that daemon reads its own file fine.
 */
const hostRoutingSchema = hostFileSchema
  .pick({ host_enrollment_id: true, local_token: true, port: true })
  .partial({ port: true });

function readHostRouting(
  path: string,
): ReturnType<typeof hostRoutingSchema.parse> | undefined {
  try {
    const parsed = hostRoutingSchema.safeParse(readJsonFileIfExists(path));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function harnessFromArgv(argv: readonly string[]): TachoHarness {
  const index = argv.indexOf("--harness");
  const value = index >= 0 ? argv[index + 1] : undefined;
  const parsed = tachoHarnessSchema.safeParse(value);
  return parsed.success ? parsed.data : "claude-code";
}

/**
 * The `--agent <name>` flag: undefined when absent, `""` when given without
 * a value (so the hook refuses it rather than recording an unnamed agent).
 */
export function agentFromArgv(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--agent");
  if (index < 0) return undefined;
  return argv[index + 1] ?? "";
}

/**
 * The `--enrollment <id>` flag the settings writers put on every hook entry,
 * or undefined when it is absent or not an enrollment id.
 */
export function enrollmentFromArgv(
  argv: readonly string[],
): string | undefined {
  const index = argv.indexOf("--enrollment");
  if (index < 0) return undefined;
  const parsed = hostEnrollmentIdSchema.safeParse(argv[index + 1]);
  return parsed.success ? parsed.data : undefined;
}

export interface UnixPostOptions {
  /** The daemon's Unix socket; on Windows `loopbackPort` is used instead. */
  socketPath?: string;
  /** `127.0.0.1:<port>`, the transport when there is no Unix socket. */
  loopbackPort?: number;
  path: string;
  headers: Record<string, string>;
  body: string;
  connectTimeoutMs: number;
  responseTimeoutMs: number;
}

export interface UnixPostResult {
  status: number;
  body: string;
}

/**
 * POST to the daemon with separate connect and response budgets, over the
 * Unix socket when one is given and over loopback TCP otherwise (Windows).
 */
export function postUnix(options: UnixPostOptions): Promise<UnixPostResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...(options.socketPath !== undefined
          ? { socketPath: options.socketPath }
          : { host: "127.0.0.1", port: options.loopbackPort }),
        path: options.path,
        method: "POST",
        // One fresh socket per hook: the global agent's keep-alive would hand
        // back an already-connected socket whose "connect" never fires.
        agent: false,
        headers: {
          ...options.headers,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(options.body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    let connected = false;
    const connectTimer = setTimeout(() => {
      if (!connected) req.destroy(new Error("connect timeout"));
    }, options.connectTimeoutMs);
    req.on("socket", (socket) => {
      if (!socket.connecting) {
        connected = true;
        clearTimeout(connectTimer);
        return;
      }
      socket.once("connect", () => {
        connected = true;
        clearTimeout(connectTimer);
      });
    });
    req.setTimeout(options.responseTimeoutMs, () =>
      req.destroy(new Error("response timeout")),
    );
    req.on("error", (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });
    req.end(options.body);
  });
}

export interface HookRunDeps {
  paths: TachoPaths;
  env: Record<string, string | undefined>;
  stdin: string;
  now?: () => number;
  post?: (options: UnixPostOptions) => Promise<UnixPostResult>;
  /** Milliseconds allowed to reach the daemon before deciding locally. */
  connectTimeoutMs?: number;
  readHost?: () => HostFile | undefined;
  /**
   * The enrollment this hook entry was written for (`--enrollment`).
   * Defaults to the flag on this process's own command line.
   */
  enrollment?: string;
  /** Which harness ran this hook (`--harness`); the daemon labels the session. */
  harness?: TachoHarness;
  /**
   * A custom agent's name (`--agent`). Its payload is Claude Code's shape;
   * the session is labelled `runtime: "custom"`. Wins over `harness`.
   */
  agent?: string;
  /**
   * The harness process's pid, for a harness that exports none: Stella
   * (whose payload names no session either) and Codex. For Codex it defaults
   * to walking up from this process's parent with `ps` (`codexHarnessPid`),
   * and for Stella to the cached identity (`resolveStellaIdentity`).
   * Undefined means no pid names this one session, and the daemon falls back
   * to its idle bound. Codex asks only at `SessionStart` and
   * `UserPromptSubmit`. Cursor never asks. Given for Stella, it and
   * `harnessInstance` replace the cache.
   */
  harnessPid?: () => number | undefined;
  /**
   * The Stella process instance token (its start time), which keeps a reused
   * pid off the previous run's chain. `undefined` from it means the session
   * id falls back to the bare pid form. Given, it replaces the cache the way
   * `harnessPid` does.
   */
  harnessInstance?: (pid: number) => string | undefined;
  /**
   * The two `ps` reads behind a Stella identity when neither override above
   * is given: the parent's parent and name, and a process's start time. The
   * identity is cached under `TACHO_HOME` (`resolveStellaIdentity`), so most
   * hooks call neither. A test injects them to count the calls or to fail
   * one.
   */
  stellaPs?: {
    lookup?: PsLookup;
    startInstance?: (pid: number) => string | undefined;
  };
  /** `win32` has no Unix socket, so the hook posts over loopback TCP. */
  platform?: NodeJS.Platform;
  /**
   * Milliseconds since the harness started this process. The time spent
   * starting up, reading stdin and running `ps` comes out of the daemon's
   * response budget, so the whole hook still finishes under the harness's
   * timeout. `runHookProcess` passes the process uptime. It defaults to 0 for
   * a caller (a test, an SDK adapter) that did not start a process for the
   * hook.
   */
  elapsedMs?: () => number;
  /**
   * Identifies this one hook invocation across the live request and its
   * spool fallback, so a daemon that already recorded the live request does
   * not record the spool replay of the same hook a second time (a client
   * timeout does not mean the daemon never got it). Generated once, when
   * stdin is read — `runHookProcess` does this rather than leaving it to
   * default here, so the id is fixed before the network attempt that might
   * time out, not after. Defaults to a fresh id for a caller (a test, an
   * SDK adapter) that has no earlier point to generate one from. The daemon
   * keeps it for as long as this client could still write the spool file
   * (see `SessionRecord.hookIds` in `collector/registry.ts`).
   */
  hookId?: string;
}

export interface HookRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Where the decision came from. */
  path: "daemon" | "local" | "unenrolled" | "invalid";
  evaluation?: Evaluation;
}

/**
 * The time the hook keeps back under the harness's timeout, so a daemon that
 * accepts the connection and never answers still leaves this process time
 * to decide locally, spool the event and exit before the harness kills it.
 * It covers the harness's own spawn (Codex runs a hook through a login
 * shell), the local decision and the spool write. Half the timeout, and
 * never more than five seconds.
 */
const HARNESS_TIMEOUT_MARGIN_MS = 5_000;

/**
 * The least time the daemon gets once stdin or `ps` has used up the rest. A
 * daemon that is up answers over the socket in a few milliseconds.
 */
const MIN_RESPONSE_BUDGET_MS = 100;

/**
 * The timeout assumed for an event the harness's writer does not register:
 * the shortest one any writer registers, five seconds, which is what Claude
 * Code's http hooks and every telemetry command hook of Codex, Cursor and
 * Stella get.
 */
const UNREGISTERED_EVENT_KILL_MS = 5_000;

/**
 * How long the harness waits for this hook before it kills the process, in
 * milliseconds. It is the timeout the harness's writer registers for the
 * event, so the hook reads the same number the harness enforces. The same
 * event can differ by harness: Claude Code gives `SessionEnd` ten seconds,
 * while Codex and Cursor give it five (H-13).
 *
 * `cursorEvent` is Cursor's own event name, because Cursor's timeouts are
 * set per Cursor event and two of them can map to one Claude Code name.
 */
export function harnessKillMs(
  harness: TachoHarness,
  event: string,
  cursorEvent?: string,
): number {
  switch (harness) {
    case "codex":
      return (CODEX_HOOK_EVENTS as readonly string[]).includes(event)
        ? codexHookTimeoutS(event as CodexHookEventName) * 1_000
        : UNREGISTERED_EVENT_KILL_MS;
    case "cursor":
      return cursorEvent !== undefined &&
        Object.hasOwn(CURSOR_TO_CLAUDE_EVENT, cursorEvent)
        ? cursorHookTimeoutS(cursorEvent as CursorHookEventName) * 1_000
        : UNREGISTERED_EVENT_KILL_MS;
    case "stella":
      return (STELLA_HOOK_EVENTS as readonly string[]).includes(event)
        ? stellaHookTimeoutMs(event as StellaHookEventName)
        : UNREGISTERED_EVENT_KILL_MS;
    default:
      if (Object.hasOwn(COMMAND_HOOK_TIMEOUTS_S, event))
        return (
          COMMAND_HOOK_TIMEOUTS_S[
            event as keyof typeof COMMAND_HOOK_TIMEOUTS_S
          ] * 1_000
        );
      return event === "SessionEnd"
        ? SESSION_END_TIMEOUT_S * 1_000
        : UNREGISTERED_EVENT_KILL_MS;
  }
}

/**
 * How long to wait for the daemon's answer: the harness timeout, less the
 * margin, less what this process has already spent since it started.
 *
 * | Harness timeout | Budget from process start |
 * |---|---|
 * | 5 s (telemetry on Codex, Cursor and Stella; Codex and Cursor `SessionEnd`) | 2.5 s |
 * | 10 s (`SessionStart`, `UserPromptSubmit`, `Stop`; Claude Code `SessionEnd`) | 5 s |
 * | 15 s (`PreToolUse`; Cursor `subagentStart`) | 10 s |
 * | 600 s (`PermissionRequest`) | 595 s |
 *
 * The budget used to be a fixed 5 s for every telemetry event, equal to the
 * five-second kill, so a daemon slower than that got the process killed
 * before it could spool the event (H-13).
 */
export function responseBudgetMs(killMs: number, elapsedMs = 0): number {
  const margin = Math.min(HARNESS_TIMEOUT_MARGIN_MS, killMs / 2);
  return Math.max(
    MIN_RESPONSE_BUDGET_MS,
    Math.floor(killMs - margin - elapsedMs),
  );
}

/** The Codex hooks that look for the Codex process (`codexHarnessPid`). */
const CODEX_PID_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "UserPromptSubmit",
]);

type HostStatus = HostFile["host_status"];

function operatorBlockLocal(status: HostStatus): string | undefined {
  if (status === "suspended" || status === "revoked") {
    return `This host is ${status} by its Oxagen operator.`;
  }
  if (status === "paused") return "This host is paused by its Oxagen operator.";
  return undefined;
}

/** What the offline path knows about the host before it decides. */
interface LocalFacts {
  bundleVerified: boolean;
  hostStatus: HostStatus;
  match: MatchContext;
}

/** Home and platform for rule matching; the cwd comes from each payload. */
function localMatchContext(): MatchContext {
  let home: string | undefined;
  try {
    home = homedir();
  } catch {
    home = undefined;
  }
  return {
    ...(home !== undefined && home.length > 0 ? { home } : {}),
    platform: process.platform,
  };
}

/**
 * Every hook path this evaluator answers allow on when it cannot reach the
 * daemon and cannot decide from the cached bundle. Signed onto the bundle
 * itself as `hook_fail_open` (`packages/handlers/src/lib/tacho-host.ts`) so
 * the set an operator relies on is read from the record, not from this file.
 *
 * `SessionStart` and `UserPromptSubmit` carry no tool identity to evaluate at
 * all; `Stop`, `PostToolUse`, `PostToolUseFailure`, `Notification`,
 * `PermissionDenied` and `SessionEnd` refuse nothing (the `default` branch
 * below). The daemon answers `Stop` and the two post-tool events with the
 * operator's queued
 * steers and a resume's continuation; with the daemon down, those stay
 * queued for the next boundary it answers. Of the three tool-bearing events, only `ask` and `no_rule`
 * outcomes fail open, and even then to the harness's OWN permission prompt, a
 * channel that needs no daemon, not to a silent allow. A `deny` outcome on
 * any of the three fails CLOSED; see `evaluateToolPermission`.
 */
export const FAIL_OPEN_HOOK_PATHS: readonly string[] = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "PermissionDenied",
  "SessionEnd",
  "PreToolUse:ask",
  "PreToolUse:no_rule",
  "PermissionRequest:ask",
  "PermissionRequest:no_rule",
  "SubagentStart:ask",
  "SubagentStart:no_rule",
];

/**
 * A `PermissionRequest` answer is `decision: { behavior }`, not the
 * `permissionDecision` string `PreToolUse` takes. Claude Code reads no
 * opinion from the wrong shape and falls to its own prompt, which is how a
 * mandate deny became inert on this path while the daemon was down. "ask"
 * has no behavior here: the request is already the prompt, so `{}` lets it
 * stand.
 */
function permissionRequestResponse(
  decision: Evaluation["decision"],
  ruleAllow: boolean,
  reason: string,
): Record<string, unknown> {
  if (decision === "deny")
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: reason },
      },
    };
  if (ruleAllow)
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    };
  return {};
}

/**
 * Evaluate one tool-bearing event against the cached bundle, in whatever
 * shape that event's own hook answer takes. Shared by `PreToolUse`,
 * `PermissionRequest` and `SubagentStart` (Cursor's own permission event for
 * a subagent launch) so the three can never drift into answering the same
 * mandate three different ways. The defect this replaces was exactly that:
 * `PermissionRequest` fell through to an unconditional `{}` (allow) whenever
 * the daemon was unreachable, never consulting the bundle at all, even for a
 * tool the mandate explicitly denies.
 */
function evaluateToolPermission(
  host: HostFile,
  local: LocalFacts,
  now: number,
  eventName: "PreToolUse" | "PermissionRequest" | "SubagentStart",
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  cwd: string | undefined,
  harnessReadOnly?: boolean,
): { response: Record<string, unknown>; evaluation: Evaluation; note: string } {
  const evaluation = evaluatePreToolUse({
    bundle: host.bundle,
    bundleVerified: local.bundleVerified,
    toolName,
    ...(toolInput !== undefined ? { toolInput } : {}),
    hostStatus: local.hostStatus,
    latestDenyGeneration: host.deny_generation,
    // No daemon means no re-evaluation: a stale bundle fails closed.
    controlReachable: false,
    ...(harnessReadOnly === true ? { harnessReadOnly } : {}),
    now,
    context: { ...local.match, ...(cwd !== undefined ? { cwd } : {}) },
  });
  // The mode is read only from a verified bundle: an edited host.json must
  // not be able to claim observe mode and turn a deny into an allow.
  const decision =
    evaluation.decision === "defer"
      ? local.bundleVerified && host.bundle.mode === "observe"
        ? "allow"
        : "deny"
      : evaluation.decision;
  const finalEvaluation: Evaluation = { ...evaluation, decision };
  const ruleAllow =
    decision === "allow" &&
    evaluation.evaluated === "allow" &&
    evaluation.rule !== undefined;
  const response =
    eventName === "PermissionRequest"
      ? permissionRequestResponse(decision, ruleAllow, evaluation.reason)
      : decision === "deny"
        ? {
            hookSpecificOutput: {
              hookEventName: eventName,
              permissionDecision: "deny",
              permissionDecisionReason: evaluation.reason,
            },
          }
        : decision === "ask" && evaluation.rule !== undefined
          ? {
              hookSpecificOutput: {
                hookEventName: eventName,
                permissionDecision: "ask",
                permissionDecisionReason: evaluation.reason,
              },
            }
          : ruleAllow
            ? {
                hookSpecificOutput: {
                  hookEventName: eventName,
                  permissionDecision: "allow",
                  permissionDecisionReason: evaluation.reason,
                },
              }
            : {};
  return {
    response,
    evaluation: finalEvaluation,
    note: `daemon down; decided ${decision} from cached bundle`,
  };
}

/** Decide from the cached bundle alone; the daemon replays the event later. */
export function decideLocally(
  host: HostFile,
  input: ReturnType<typeof hookInputSchema.parse>,
  now: number,
  match: MatchContext = localMatchContext(),
): {
  response: Record<string, unknown>;
  evaluation?: Evaluation;
  note: string;
} {
  const bundleVerified = verifyBundle(
    host.bundle,
    host.bundle_public_key_pem,
    host.host_enrollment_id,
  ).ok;
  const local: LocalFacts = {
    bundleVerified,
    hostStatus: hostStatusInForce(host, bundleVerified),
    match,
  };
  const block = operatorBlockLocal(local.hostStatus);
  // Stella's own read-only claim for the tool, when it made one.
  const harnessReadOnly =
    (input as Record<string, unknown>)["tool_read_only"] === true;
  switch (input.hook_event_name) {
    case "SessionStart":
      if (block !== undefined)
        return {
          response: { continue: false, stopReason: block },
          note: "blocked by host status",
        };
      return {
        response:
          host.bundle.context.system !== null
            ? {
                hookSpecificOutput: {
                  hookEventName: "SessionStart",
                  additionalContext: host.bundle.context.system,
                },
              }
            : {},
        note: "daemon down; recorded for replay",
      };
    case "UserPromptSubmit":
      if (block !== undefined)
        return {
          response: { decision: "block", reason: block },
          note: "blocked by host status",
        };
      return { response: {}, note: "daemon down; recorded for replay" };
    case "PermissionRequest": {
      if (block !== undefined) {
        return {
          response: {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "deny", message: block },
            },
          },
          note: "blocked by host status",
        };
      }
      if (input.tool_name === undefined) {
        // No tool identity on the payload at all: nothing to evaluate.
        return { response: {}, note: "daemon down; recorded for replay" };
      }
      return evaluateToolPermission(
        host,
        local,
        now,
        "PermissionRequest",
        input.tool_name,
        input.tool_input,
        input.cwd,
        harnessReadOnly,
      );
    }
    case "PreToolUse":
      return evaluateToolPermission(
        host,
        local,
        now,
        "PreToolUse",
        input.tool_name ?? "unknown",
        input.tool_input,
        input.cwd,
        harnessReadOnly,
      );
    case "SubagentStart": {
      // Cursor treats subagentStart as a permission event. An empty answer
      // becomes allow, so a paused or revoked host would launch model-backed
      // subagents unless this path decides. Evaluate as Task: one rule covers
      // Claude Code's Task tool and Cursor's subagent start.
      if (block !== undefined) {
        return {
          response: {
            hookSpecificOutput: {
              hookEventName: "SubagentStart",
              permissionDecision: "deny",
              permissionDecisionReason: block,
            },
          },
          note: "blocked by host status",
        };
      }
      const toolInput =
        input.agent_type !== undefined || input.agent_id !== undefined
          ? {
              ...(input.agent_type !== undefined
                ? { subagent_type: input.agent_type }
                : {}),
              ...(input.agent_id !== undefined
                ? { subagent_id: input.agent_id }
                : {}),
            }
          : undefined;
      return evaluateToolPermission(
        host,
        local,
        now,
        "SubagentStart",
        "Task",
        toolInput,
        input.cwd,
      );
    }
    default:
      return { response: {}, note: "daemon down; recorded for replay" };
  }
}

/** Codex ignores PreToolUse ask, so require approval by refusing the call. */
function codexAnswer(
  response: Record<string, unknown>,
  event: string,
): Record<string, unknown> {
  const output = response["hookSpecificOutput"];
  if (
    event !== "PreToolUse" ||
    typeof output !== "object" ||
    output === null ||
    Array.isArray(output)
  )
    return response;
  const fields = output as Record<string, unknown>;
  if (fields["permissionDecision"] !== "ask") return response;
  const reason =
    typeof fields["permissionDecisionReason"] === "string"
      ? fields["permissionDecisionReason"]
      : "Oxagen policy requires approval.";
  return {
    ...response,
    hookSpecificOutput: {
      ...fields,
      permissionDecision: "deny",
      permissionDecisionReason: `${reason} Codex cannot ask for approval through this hook. Approve the request in Oxagen before retrying.`,
    },
  };
}

/** The most a quarantined unreadable payload keeps, so one huge stdin cannot fill the disk. */
const MAX_QUARANTINED_PAYLOAD_BYTES = 65_536;

/**
 * A payload this process could not even parse, kept where a person can find
 * it, bounded so an oversized or runaway stdin does not turn the record
 * itself into the next problem. Best-effort and silent on its own failure:
 * this runs from a branch that has already decided its answer, and a write
 * failure here must not turn that answer into an unhandled rejection.
 *
 * `paths.quarantine`, not `paths.spool`: the spool is for a hook the daemon
 * never got to see and should still process once reachable, and the daemon
 * already reads every file there as a replay candidate. This payload was
 * never going to become an event — nothing here would replay it — so it
 * goes where "the control plane refused this, kept for inspection" already
 * lives, and the daemon's existing sweep and count age it out the same way.
 */
function quarantineUnreadablePayload(
  deps: HookRunDeps,
  hookId: string,
  receivedAt: string,
  reason: string,
  rawText: string,
  label: Record<string, string>,
): void {
  quarantineHookPayload(deps.paths.quarantine, {
    hookId,
    receivedAt,
    reason,
    rawText,
    label,
  });
}

/**
 * Keep one hook payload that cannot become an event in `quarantine/`, where
 * `tacho status` counts it and the daemon's sweep ages it out. `tacho-hook`
 * calls it for stdin it cannot read, and the daemon for an http hook body it
 * cannot file on a session. Best-effort and silent on its own failure.
 */
export function quarantineHookPayload(
  quarantineDir: string,
  record: {
    hookId: string;
    receivedAt: string;
    reason: string;
    rawText: string;
    label: Record<string, string>;
  },
): void {
  const { hookId, receivedAt, reason, rawText, label } = record;
  try {
    ensureDir(quarantineDir);
    const truncated = rawText.length > MAX_QUARANTINED_PAYLOAD_BYTES;
    writeSensitiveFileAtomic(
      join(quarantineDir, `${hookId}.hook-payload.json`),
      JSON.stringify({
        schema: "tacho.quarantined-hook-payload.v1",
        received_at: receivedAt,
        hook_id: hookId,
        reason,
        payload_truncated: truncated,
        raw: truncated
          ? rawText.slice(0, MAX_QUARANTINED_PAYLOAD_BYTES)
          : rawText,
        ...label,
      }),
    );
  } catch {
    // Best-effort; the caller already has its answer.
  }
}

export async function runTachoHook(deps: HookRunDeps): Promise<HookRunResult> {
  const now = deps.now ?? (() => Date.now());
  const hookId = deps.hookId ?? ulid(now());
  // Captured once, here, rather than after the daemon POST fails: a spool
  // fallback used to stamp `received_at` at the moment the request timed
  // out, which for `PermissionRequest`'s 600s budget could read minutes
  // after the hook actually arrived. This is when the hook did.
  const receivedAt = toProtocolTimestamp(now());
  const platform = deps.platform ?? process.platform;
  const agent = deps.agent;
  const agentProblem =
    agent !== undefined ? customAgentNameProblem(agent) : undefined;
  if (agentProblem !== undefined) {
    return {
      stdout: "{}\n",
      stderr: `tacho-hook: invalid --agent name ${JSON.stringify(agent)}; ${agentProblem}\n`,
      exitCode: 0,
      path: "invalid",
    };
  }
  // `--agent` is the more specific claim: a custom agent speaks Claude
  // Code's hook shape whatever `--harness` also says.
  const harness: TachoHarness =
    agent !== undefined ? "claude-code" : (deps.harness ?? "claude-code");
  const stella = harness === "stella";
  const cursor = harness === "cursor";
  // Stella and Cursor speak their own hook shapes; their adapters translate
  // the payload in and the answer out. Codex shares the payload but needs
  // an explicit refusal when its hook protocol cannot honor an ask.
  const codex = harness === "codex";
  const translated = stella || cursor || codex;
  let raw: unknown;
  try {
    raw = JSON.parse(deps.stdin);
  } catch {
    // Neither spooled (there is no parsed payload to replay) nor recorded
    // anywhere before this fix — the loss was in a log line only. The raw
    // bytes go to quarantine, bounded, so a person can see what arrived and
    // why nothing was recorded for it.
    quarantineUnreadablePayload(
      deps,
      hookId,
      receivedAt,
      "stdin is not JSON",
      deps.stdin,
      agent !== undefined ? { agent } : { harness },
    );
    return {
      // Truncated or malformed JSON is the likeliest way a payload arrives
      // unreadable, and it is answered the same way a readable payload that
      // fails the schema is. An earlier pass fixed only the schema branch
      // and left this one, a dozen lines above it, still answering with
      // nothing. `cursorRefusal` reads the event name off the payload, and
      // there is no payload here, so it refuses in both shapes at once.
      stdout: cursor
        ? cursorRefusal(undefined, CURSOR_UNREADABLE_PAYLOAD)
        : "{}\n",
      stderr: "tacho-hook: stdin is not JSON\n",
      exitCode: 0,
      path: "invalid",
    };
  }
  // The enrollment is read before anything that spawns a process, so an
  // unenrolled machine answers a Stella hook without running `ps` (H-14).
  // What the read found is acted on further down, after the payload parse.
  let host: HostFile | undefined;
  let hostReadError: { error: unknown } | undefined;
  try {
    host = (deps.readHost ?? (() => readHostFile(deps.paths.hostFile)))();
  } catch (error) {
    hostReadError = { error };
  }
  let harnessPid: number | undefined;
  if (stella) {
    let identity: StellaIdentity;
    if (deps.harnessPid !== undefined || deps.harnessInstance !== undefined) {
      const pid =
        deps.harnessPid?.() ?? stellaHarnessPid(process.ppid, platform);
      // Windows has no `ps`, so there the id stays the bare pid form.
      const instance = (
        deps.harnessInstance ??
        ((pid: number) =>
          platform === "win32" ? undefined : psStartInstance(pid))
      )(pid);
      identity = { pid, ...(instance !== undefined ? { instance } : {}) };
    } else if (host === undefined && hostReadError === undefined) {
      // Unenrolled: nothing is posted or spooled, so the id is never read.
      identity = { pid: process.ppid };
    } else {
      identity = resolveStellaIdentity({
        parentPid: process.ppid,
        platform,
        cacheDir: join(deps.paths.root, "stella-identity"),
        now: now(),
        ...(deps.stellaPs?.lookup !== undefined
          ? { lookup: deps.stellaPs.lookup }
          : {}),
        ...(deps.stellaPs?.startInstance !== undefined
          ? { startInstance: deps.stellaPs.startInstance }
          : {}),
      });
    }
    if (host !== undefined || hostReadError !== undefined)
      harnessPid = identity.pid;
    raw = translateStellaPayload(raw, identity.pid, identity.instance);
  }
  // Cursor issues both the session id and the tool-use id, so its adapter
  // only renames. It gets no harness pid, on purpose (#3989). In Cursor
  // 3.22.7 the one code path that runs a command hook is the agent-host
  // daemon (`extensions/cursor-agent-host/dist/agent-host-daemon/dist/bin/
  // daemon.cjs`: `CliHooksExecutor.executeCommandScript` runs the command
  // through `NaiveTerminalExecutor`, which spawns `$SHELL -c`). The
  // extension starts that daemon detached and reuses one already listening
  // on its socket, and one executor tracks many conversations
  // (`activeSessionIdsByConversationId`). So the walk would reach a process
  // that many Cursor conversations share: it outlives each of them, and a
  // cancel of one conversation would signal the rest. A Cursor session ends
  // on Cursor's own `sessionEnd`, or after an hour with no hook (ADR-141).
  // Cursor sets its hook timeouts per Cursor event, so its own name is kept
  // for the response budget before the adapter renames it.
  const cursorEvent =
    cursor &&
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as Record<string, unknown>)["hook_event_name"] === "string"
      ? ((raw as Record<string, unknown>)["hook_event_name"] as string)
      : undefined;
  if (cursor) raw = translateCursorPayload(raw);
  const parsed = hookInputSchema.safeParse(raw);
  if (!parsed.success) {
    // JSON that parsed but does not read as a hook Oxagen knows: also
    // quarantined, so a schema drift on the harness side leaves the same
    // durable trace a malformed body does, rather than only the refusal
    // reason below.
    quarantineUnreadablePayload(
      deps,
      hookId,
      receivedAt,
      `payload is not a ${stella ? "Stella" : cursor ? "Cursor" : "Claude Code"} hook`,
      JSON.stringify(raw),
      agent !== undefined ? { agent } : { harness },
    );
    return {
      // A payload this hook cannot parse is not a reason to let the call
      // through on Cursor. `{}` reads as no opinion to Claude Code, and
      // Cursor's `failClosed` does not cover it either, because the hook did
      // not crash, time out or exit non-zero: it answered, successfully, with
      // nothing. So a truncated payload or a schema change on Cursor's side
      // would quietly stop enforcing while every call was recorded as
      // allowed. The refusal is explicit instead, for the same reason an
      // unreadable enrollment refuses below.
      //
      // The shape has to match the event, which an earlier version of this
      // got wrong. Cursor reads `permission` at `preToolUse` and `continue`
      // at `beforeSubmitPrompt`, so one blanket `permission: deny` was
      // ignored outright at the prompt veto and the malformed prompt went
      // through. The event name is read off the raw payload rather than the
      // parsed one, because parsing is what failed, and a payload too broken
      // to name its own event is answered in both shapes at once: Cursor
      // reads the member its event defines and ignores the other, and
      // refusing an event that needed no refusal costs nothing next to
      // allowing one that did.
      stdout: cursor ? cursorRefusal(raw, CURSOR_UNREADABLE_PAYLOAD) : "{}\n",
      stderr: `tacho-hook: payload is not a ${stella ? "Stella" : cursor ? "Cursor" : "Claude Code"} hook\n`,
      exitCode: 0,
      path: "invalid",
    };
  }
  const input = parsed.data;
  // Codex exports no pid, and without one a session that exits without its
  // SessionEnd waits out the daemon's six-hour idle bound (#3989). The walk
  // runs at the session's start and at each prompt, not on every tool call:
  // the registry keeps a pid once a hook has carried it, and the prompt is
  // the fallback for a session first seen mid-run.
  if (codex && CODEX_PID_EVENTS.has(input.hook_event_name))
    harnessPid = (
      deps.harnessPid ?? (() => codexHarnessPid(process.ppid, platform))
    )();
  // Stella reads `{"action": ...}` decisions and takes SessionStart stdout
  // as prompt text; Cursor reads a flat permission object whose shape differs
  // per event; every other harness reads Claude Code's answer as is.
  const answer = (response: Record<string, unknown>): string =>
    stella
      ? stellaAnswer(response, input.hook_event_name)
      : cursor
        ? cursorAnswer(response, input.hook_event_name)
        : `${JSON.stringify(codex ? codexAnswer(response, input.hook_event_name) : response)}\n`;
  const emptyAnswer = answer({});
  /**
   * The answer for a machine that has enrollment state this hook cannot
   * read, which is not the same as a machine with none.
   *
   * An unenrolled machine is one Oxagen does not govern, and allowing its
   * calls is right. A machine whose `host.json` exists but will not parse is
   * a governed machine whose mandate is unreadable, and the safe answer
   * there is to refuse rather than to wave the call through.
   *
   * It matters more on Cursor than elsewhere. Claude Code reads `{}` as no
   * opinion and applies its own default, but `cursorAnswer` turns the same
   * empty response into an explicit `{"permission":"allow"}` at a veto
   * point. Cursor's `failClosed` does not catch that, because the hook did
   * not crash, time out or exit non-zero: it succeeded and granted
   * permission. So a corrupted enrollment file would let every tool call on
   * that machine proceed with no verified mandate, and the record would say
   * each one was allowed.
   */
  const unreadableAnswer = cursor
    ? answer({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: UNREADABLE_ENROLLMENT,
        },
      })
    : emptyAnswer;
  const killMs = harnessKillMs(harness, input.hook_event_name, cursorEvent);
  const elapsed = deps.elapsedMs ?? (() => 0);
  // Read at each post, so the time already spent comes off the budget.
  const responseBudget = (): number => responseBudgetMs(killMs, elapsed());
  const env: Record<string, string> = {
    ...snapshotEnv(deps.env, DEFAULT_SECRET_ENV_PATTERN),
    ...(harnessPid !== undefined
      ? { TACHO_HARNESS_PID: String(harnessPid) }
      : {}),
  };
  const post = deps.post ?? postUnix;
  const useTcp = platform === "win32";
  const label = agent !== undefined ? { agent } : { harness };
  const enrollment = deps.enrollment ?? enrollmentFromArgv(process.argv);
  /**
   * A hook entry written for another enrollment than this machine's is
   * stale: re-enrolling rewrites the entries it knows about, and one left in
   * a file it did not rewrite would post every event a second time under
   * the current id. It answers with no opinion and posts nothing.
   */
  const staleEntry = (current: string): HookRunResult | undefined =>
    enrollment !== undefined && enrollment !== current
      ? {
          stdout: emptyAnswer,
          stderr: `tacho-hook: this hook entry is for enrollment ${enrollment}, not this machine's ${current}; ignored it. Run \`tacho enroll\` to rewrite the hooks.\n`,
          exitCode: 0,
          path: "invalid",
        }
      : undefined;
  if (hostReadError !== undefined) {
    const { error } = hostReadError;
    const problem = error instanceof Error ? error.message : String(error);
    // Forward on the routing fields alone when they read: the daemon that
    // wrote the file can decide, and only the offline fallback needs the
    // full parse.
    const routing = readHostRouting(deps.paths.hostFile);
    if (routing !== undefined) {
      const stale = staleEntry(routing.host_enrollment_id);
      if (stale !== undefined) return stale;
      const port = routing.port;
      if (!useTcp || port !== undefined) {
        try {
          const result = await post({
            ...(useTcp
              ? { loopbackPort: port }
              : { socketPath: deps.paths.socket }),
            path: `/hook/${routing.host_enrollment_id}`,
            headers: {
              Authorization: `Bearer ${routing.local_token}`,
              "x-tacho-envelope": "1",
            },
            body: JSON.stringify({ payload: raw, env, ...label }),
            connectTimeoutMs: deps.connectTimeoutMs ?? 50,
            responseTimeoutMs: responseBudget(),
          });
          const document =
            result.status === 200 ? tryParseAnswerBody(result.body) : undefined;
          if (document !== undefined)
            return {
              stdout: translated
                ? answer(document)
                : `${result.body.trim() || "{}"}\n`,
              stderr: `tacho-hook: cannot read enrollment (${problem}); forwarded on its routing fields\n`,
              exitCode: 0,
              path: "daemon",
            };
        } catch {
          // The daemon did not answer either; refuse below.
        }
      }
    }
    // No daemon and no readable mandate, so the mode is unknown too. A tool
    // call is refused on every harness, not only Cursor: `{}` would let it
    // run with no policy evaluated at all.
    const refusal =
      input.hook_event_name === "PreToolUse"
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: UNREADABLE_ENROLLMENT,
            },
          }
        : input.hook_event_name === "PermissionRequest"
          ? permissionRequestResponse("deny", false, UNREADABLE_ENROLLMENT)
          : undefined;
    return {
      stdout: cursor
        ? unreadableAnswer
        : refusal !== undefined
          ? answer(refusal)
          : emptyAnswer,
      stderr: `tacho-hook: cannot read enrollment: ${problem}\n`,
      exitCode: 0,
      path: "unenrolled",
    };
  }
  if (host === undefined) {
    return {
      stdout: emptyAnswer,
      stderr: "tacho-hook: this machine is not enrolled; run `tacho enroll`\n",
      exitCode: 0,
      path: "unenrolled",
    };
  }
  const stale = staleEntry(host.host_enrollment_id);
  if (stale !== undefined) return stale;
  try {
    const result = await post({
      ...(useTcp
        ? { loopbackPort: host.port }
        : { socketPath: deps.paths.socket }),
      path: `/hook/${host.host_enrollment_id}`,
      headers: {
        Authorization: `Bearer ${host.local_token}`,
        "x-tacho-envelope": "1",
      },
      body: JSON.stringify({ payload: raw, env, hook_id: hookId, ...label }),
      connectTimeoutMs: deps.connectTimeoutMs ?? 50,
      responseTimeoutMs: responseBudget(),
    });
    if (result.status === 200) {
      // A 200 whose body is not a JSON object is a fault, not a decision. It
      // falls through to the local evaluator rather than being read as an
      // empty answer, because a translated harness turns an empty answer into
      // an explicit allow and a truncated or blank response would permit the
      // call. An intentional `"{}"` still parses; only blank or non-object
      // bodies are rejected.
      const document = tryParseAnswerBody(result.body);
      if (document === undefined)
        throw new Error(
          `daemon answered 200 with a body that is not a JSON object: ${result.body.slice(0, 200)}`,
        );
      return {
        stdout: translated
          ? answer(document)
          : `${result.body.trim() || "{}"}\n`,
        stderr: "",
        exitCode: 0,
        path: "daemon",
      };
    }
    throw new Error(
      `daemon answered ${result.status}: ${result.body.slice(0, 200)}`,
    );
  } catch (error) {
    const local = decideLocally(host, input, now());
    // The spool write is best-effort, not a precondition for answering.
    // Losing it used to lose the local decision too — the throw escaped
    // before `stdout`/`stderr` were ever built, so a deny this process just
    // computed became an unhandled rejection instead of an answer, which a
    // harness that gets no output at all treats as an allow. The write is
    // wrapped so a full disk or an unwritable spool dir costs the replay,
    // noted on stderr, not the decision already made.
    let spoolError: unknown;
    try {
      ensureDir(deps.paths.spool);
      writeSensitiveFileAtomic(
        join(deps.paths.spool, `${hookId}.json`),
        JSON.stringify({
          schema: "tacho.spool.v1",
          received_at: receivedAt,
          hook_id: hookId,
          payload: raw,
          env,
          ...label,
          ...(local.evaluation !== undefined
            ? { evaluation: local.evaluation }
            : {}),
        }),
      );
    } catch (writeError) {
      spoolError = writeError;
    }
    const spoolNote =
      spoolError !== undefined
        ? ` (also failed to spool for replay: ${spoolError instanceof Error ? spoolError.message : String(spoolError)})`
        : "";
    return {
      stdout: answer(local.response),
      stderr: `tacho-hook: ${local.note} (${error instanceof Error ? error.message : String(error)})${spoolNote}\n`,
      exitCode: 0,
      path: "local",
      ...(local.evaluation !== undefined
        ? { evaluation: local.evaluation }
        : {}),
    };
  }
}
