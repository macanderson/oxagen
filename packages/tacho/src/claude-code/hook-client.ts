/**
 * What `tacho-hook` does (spec section 5.4): read the hook payload from
 * stdin, hand it to the daemon over the Unix socket inside a tight budget,
 * and print the daemon's answer. When the daemon does not answer, decide
 * from the cached bundle, spool the event for replay, and answer anyway, so
 * enforcement never depends on the daemon being up.
 */
import { request } from "node:http";
import { join } from "node:path";
import {
  evaluatePreToolUse,
  type Evaluation,
  verifyBundle,
} from "../host/bundle";
import { ensureDir, writeSensitiveFileAtomic } from "../host/fs";
import { type HostFile, readHostFile } from "../host/host-file";
import type { TachoPaths } from "../host/paths";
import { ulid } from "../ids";
import { toProtocolTimestamp } from "../timestamp";
import {
  CUSTOM_AGENT_NAME_PATTERN,
  customAgentNameSchema,
  type TachoHarness,
  tachoHarnessSchema,
} from "../wire";
import { DEFAULT_SECRET_ENV_PATTERN, snapshotEnv } from "./context";
import { hookInputSchema } from "./hooks";
import {
  parseAnswerBody,
  stellaAnswer,
  stellaHarnessPid,
  translateStellaPayload,
} from "./stella-adapter";

/** The `--harness <name>` flag on the hook command; unknown names default to Claude Code. */
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
  /** Which harness ran this hook (`--harness`); the daemon labels the session. */
  harness?: TachoHarness;
  /**
   * A custom agent's name (`--agent`). Its payload is Claude Code's shape;
   * the session is labelled `runtime: "custom"`. Wins over `harness`.
   */
  agent?: string;
  /**
   * The Stella process's pid, for `--harness stella` (whose payload names no
   * session). Defaults to walking up from this process's parent with `ps`.
   */
  harnessPid?: () => number;
  /** `win32` has no Unix socket, so the hook posts over loopback TCP. */
  platform?: NodeJS.Platform;
}

export interface HookRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Where the decision came from. */
  path: "daemon" | "local" | "unenrolled" | "invalid";
  evaluation?: Evaluation;
}

const RESPONSE_BUDGET_MS: Record<string, number> = {
  PermissionRequest: 600_000,
  PreToolUse: 10_000,
  SessionStart: 5_000,
  UserPromptSubmit: 5_000,
  Stop: 5_000,
};

function operatorBlockLocal(host: HostFile): string | undefined {
  if (host.host_status === "suspended" || host.host_status === "revoked") {
    return `This host is ${host.host_status} by its Oxagen operator.`;
  }
  if (host.host_status === "paused")
    return "This host is paused by its Oxagen operator.";
  return undefined;
}

/** Decide from the cached bundle alone; the daemon replays the event later. */
export function decideLocally(
  host: HostFile,
  input: ReturnType<typeof hookInputSchema.parse>,
  now: number,
): {
  response: Record<string, unknown>;
  evaluation?: Evaluation;
  note: string;
} {
  const block = operatorBlockLocal(host);
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
    case "PermissionRequest":
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
      return { response: {}, note: "daemon down; recorded for replay" };
    case "PreToolUse": {
      const verified = verifyBundle(host.bundle, host.bundle_public_key_pem).ok;
      const evaluation = evaluatePreToolUse({
        bundle: host.bundle,
        bundleVerified: verified,
        toolName: input.tool_name ?? "unknown",
        ...(input.tool_input !== undefined
          ? { toolInput: input.tool_input }
          : {}),
        hostStatus: host.host_status,
        latestDenyGeneration: host.deny_generation,
        // No daemon means no re-evaluation: a stale bundle fails closed.
        controlReachable: false,
        now,
        ...(input.cwd !== undefined ? { context: { cwd: input.cwd } } : {}),
      });
      const decision =
        evaluation.decision === "defer"
          ? host.bundle.mode === "observe"
            ? "allow"
            : "deny"
          : evaluation.decision;
      const finalEvaluation: Evaluation = { ...evaluation, decision };
      const response =
        decision === "deny"
          ? {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: evaluation.reason,
              },
            }
          : decision === "ask" && evaluation.rule !== undefined
            ? {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "ask",
                  permissionDecisionReason: evaluation.reason,
                },
              }
            : decision === "allow" &&
                evaluation.evaluated === "allow" &&
                evaluation.rule !== undefined
              ? {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
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
    default:
      return { response: {}, note: "daemon down; recorded for replay" };
  }
}

export async function runTachoHook(deps: HookRunDeps): Promise<HookRunResult> {
  const now = deps.now ?? (() => Date.now());
  const platform = deps.platform ?? process.platform;
  const agent = deps.agent;
  if (agent !== undefined && !customAgentNameSchema.safeParse(agent).success) {
    return {
      stdout: "{}\n",
      stderr: `tacho-hook: invalid --agent name ${JSON.stringify(agent)}; expected ${CUSTOM_AGENT_NAME_PATTERN.source}\n`,
      exitCode: 0,
      path: "invalid",
    };
  }
  // `--agent` is the more specific claim: a custom agent speaks Claude
  // Code's hook shape whatever `--harness` also says.
  const harness: TachoHarness =
    agent !== undefined ? "claude-code" : (deps.harness ?? "claude-code");
  const stella = harness === "stella";
  let raw: unknown;
  try {
    raw = JSON.parse(deps.stdin);
  } catch {
    return {
      stdout: "{}\n",
      stderr: "tacho-hook: stdin is not JSON\n",
      exitCode: 0,
      path: "invalid",
    };
  }
  let harnessPid: number | undefined;
  if (stella) {
    harnessPid = (
      deps.harnessPid ?? (() => stellaHarnessPid(process.ppid, platform))
    )();
    raw = translateStellaPayload(raw, harnessPid);
  }
  const parsed = hookInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      stdout: "{}\n",
      stderr: `tacho-hook: payload is not a ${stella ? "Stella" : "Claude Code"} hook\n`,
      exitCode: 0,
      path: "invalid",
    };
  }
  const input = parsed.data;
  // Stella reads `{"action": ...}` decisions and takes SessionStart stdout
  // as prompt text; every other harness reads Claude Code's answer as is.
  const answer = (response: Record<string, unknown>): string =>
    stella
      ? stellaAnswer(response, input.hook_event_name)
      : `${JSON.stringify(response)}\n`;
  const emptyAnswer = answer({});
  let host: HostFile | undefined;
  try {
    host = (deps.readHost ?? (() => readHostFile(deps.paths.hostFile)))();
  } catch (error) {
    return {
      stdout: emptyAnswer,
      stderr: `tacho-hook: cannot read enrollment: ${error instanceof Error ? error.message : String(error)}\n`,
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
  const env: Record<string, string> = {
    ...snapshotEnv(deps.env, DEFAULT_SECRET_ENV_PATTERN),
    ...(harnessPid !== undefined
      ? { TACHO_HARNESS_PID: String(harnessPid) }
      : {}),
  };
  const post = deps.post ?? postUnix;
  const useTcp = platform === "win32";
  const label = agent !== undefined ? { agent } : { harness };
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
      body: JSON.stringify({ payload: raw, env, ...label }),
      connectTimeoutMs: deps.connectTimeoutMs ?? 50,
      responseTimeoutMs: RESPONSE_BUDGET_MS[input.hook_event_name] ?? 5_000,
    });
    if (result.status === 200) {
      return {
        stdout: stella
          ? answer(parseAnswerBody(result.body))
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
    const at = toProtocolTimestamp(now());
    const local = decideLocally(host, input, now());
    ensureDir(deps.paths.spool);
    writeSensitiveFileAtomic(
      join(deps.paths.spool, `${ulid(now())}.json`),
      JSON.stringify({
        schema: "tacho.spool.v1",
        received_at: at,
        payload: raw,
        env,
        ...label,
        ...(local.evaluation !== undefined
          ? { evaluation: local.evaluation }
          : {}),
      }),
    );
    return {
      stdout: answer(local.response),
      stderr: `tacho-hook: ${local.note} (${error instanceof Error ? error.message : String(error)})\n`,
      exitCode: 0,
      path: "local",
      ...(local.evaluation !== undefined
        ? { evaluation: local.evaluation }
        : {}),
    };
  }
}
