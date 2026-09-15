/**
 * `tacho verify` (spec section 5.1 step 6, `--verify`): run one headless
 * Claude Code turn and confirm the daemon chained its `agent_start` and
 * `agent_stop`. Proves the hooks, the socket, and the recorder end to end
 * on this machine; the control plane's copy is checked by `oxagen tacho`.
 */
import { readHostFile } from "../host/host-file";
import type { TachoHarness } from "../wire";
import type { CliDeps } from "./deps";

export interface VerifyOptions {
  prompt?: string;
  timeoutMs?: number;
  /** Which harness to drive (default Claude Code). */
  harness?: TachoHarness;
}

const DEFAULT_PROMPT = "Reply with exactly the word OK and nothing else.";

/**
 * One headless turn per harness. Claude Code prints a JSON result carrying
 * its session id; Codex CLI (`codex exec`) prints prose, so its session is
 * matched as the daemon's newest non-internal chain instead.
 */
function headlessTurn(
  harness: TachoHarness,
  prompt: string,
): { args: string[]; parsesSession: boolean } {
  if (harness === "codex") {
    return {
      args: ["exec", "--skip-git-repo-check", prompt],
      parsesSession: false,
    };
  }
  return {
    args: ["-p", prompt, "--max-turns", "1", "--output-format", "json"],
    parsesSession: true,
  };
}

export interface VerifyResult {
  ok: boolean;
  sessionId?: string;
  sessionUuid?: string;
  seq?: number;
  detail: string;
}

interface DaemonSession {
  session_id: string;
  session_uuid: string;
  sealed: boolean;
  seq: number;
}

export async function verify(
  options: VerifyOptions,
  deps: CliDeps,
): Promise<VerifyResult> {
  const host = readHostFile(deps.paths.hostFile);
  if (host === undefined) {
    return { ok: false, detail: "not enrolled" };
  }
  const health = (await deps.daemonGet("/health")) as
    | { ok?: boolean }
    | undefined;
  if (health?.ok !== true) {
    return {
      ok: false,
      detail: `tachod is not answering on 127.0.0.1:${host.port}`,
    };
  }
  const harness = options.harness ?? "claude-code";
  const facts = harness === "codex" ? deps.codex() : deps.claude();
  const name = harness === "codex" ? "codex" : "claude";
  if (facts.path === undefined)
    return { ok: false, detail: `\`${name}\` is not on PATH` };
  const turn = headlessTurn(harness, options.prompt ?? DEFAULT_PROMPT);
  deps.out(
    `Running ${name} ${turn.args[0]} (one headless turn) with hooks installed...`,
  );
  const run = deps.exec(facts.path, turn.args);
  if (run.status !== 0) {
    return {
      ok: false,
      detail: `${name} exited ${run.status ?? "signal"}: ${run.stderr.trim().slice(0, 300)}`,
    };
  }
  let sessionId: string | undefined;
  if (turn.parsesSession) {
    try {
      const parsed = JSON.parse(run.stdout) as { session_id?: string };
      sessionId = parsed.session_id;
    } catch {
      // Fall through: the daemon's newest session is the best guess.
    }
  }
  const deadline = deps.now() + (options.timeoutMs ?? 15_000);
  let found: DaemonSession | undefined;
  while (deps.now() < deadline) {
    const listing = (await deps.daemonGet("/sessions")) as
      | { sessions?: DaemonSession[] }
      | undefined;
    const sessions = listing?.sessions ?? [];
    found =
      sessionId !== undefined
        ? sessions.find((s) => s.session_id === sessionId)
        : sessions
            .filter((s) => !s.session_id.startsWith("tachod-"))
            .sort((a, b) => b.seq - a.seq)[0];
    if (found?.sealed === true) break;
    await deps.sleep(500);
  }
  if (found === undefined) {
    return {
      ok: false,
      ...(sessionId !== undefined ? { sessionId } : {}),
      detail:
        "the daemon never saw the session; are the hooks installed and is claude reading ~/.claude/settings.json?",
    };
  }
  if (!found.sealed) {
    return {
      ok: false,
      sessionId: found.session_id,
      sessionUuid: found.session_uuid,
      seq: found.seq,
      detail: "session started but SessionEnd never arrived within the timeout",
    };
  }
  deps.out(
    `Session ${found.session_id} chained as ${found.session_uuid}: ${found.seq} events, sealed.`,
  );
  return {
    ok: true,
    sessionId: found.session_id,
    sessionUuid: found.session_uuid,
    seq: found.seq,
    detail: "agent_start and agent_stop chained",
  };
}
