/**
 * `tacho verify` (spec section 5.1 step 6, `--verify`): run one headless
 * harness turn and confirm the daemon chained its `agent_start` and
 * `agent_stop`. Proves the hooks, the socket, and the recorder end to end
 * on this machine; the control plane's copy is checked by `oxagen tacho`.
 */
import { codexTrustProblem } from "../host/codex-hook-trust";
import { readHostFile } from "../host/host-file";
import { isInternalSession } from "../collector/registry";
import {
  HARNESS_BINARY,
  isWrappedHarness,
  type TachoHarness,
  type WrappedHarness,
} from "../wire";
import type { CliDeps } from "./deps";

export interface VerifyOptions {
  prompt?: string;
  timeoutMs?: number;
  /** Which harness to drive (default Claude Code). */
  harness?: TachoHarness;
}

const DEFAULT_PROMPT = "Reply with exactly the word OK and nothing else.";

/** The one table of harness executables; Cursor's is its unambiguous alias. */
const BINARY: Record<WrappedHarness, string> = HARNESS_BINARY;

/**
 * How long to wait for a sealed chain. Stella sends no SessionEnd: its chain
 * is sealed by the daemon's sweep (every 30 s) once the `stella` process has
 * exited, so it needs longer than a harness that ends its own session.
 */
const DEFAULT_TIMEOUT_MS: Record<WrappedHarness, number> = {
  "claude-code": 15_000,
  codex: 15_000,
  cursor: 15_000,
  stella: 45_000,
};

/**
 * How much longer to wait once tachod reports that SessionEnd arrived. The
 * chain seals when that session's final worktree read lands, and a daemon busy
 * with its first backlog can take longer than the timeout to get there.
 */
const ENDING_GRACE_MS = 30_000;

/** Said when SessionEnd arrived but the chain had not sealed in time. */
const ENDING_DETAIL =
  "SessionEnd arrived, but tachod had not finished the session's final worktree read. The chain seals once that read lands. Run `tacho verify` again in a minute";

/** Name the final evidence that verification is still waiting for. */
const UNSEALED_DETAIL: Record<WrappedHarness, string> = {
  "claude-code":
    "session started but SessionEnd never arrived within the timeout",
  codex:
    "session started but its final chain seal never arrived; check Codex Stop and SessionEnd hook delivery with `tacho status`",
  cursor:
    "session started but its final chain seal never arrived; check Cursor stop and sessionEnd hook delivery with `tacho status`",
  stella:
    "session started but was not sealed within the timeout; Stella sends no SessionEnd, so tachod seals the chain once the stella process has exited and its sweep has run",
};

/**
 * One headless turn per harness. Claude Code prints a JSON result carrying
 * its session id; Codex CLI (`codex exec`), Cursor (`cursor-agent -p`) and Stella
 * (`stella run`) are matched as a chain the daemon did not have before the
 * turn ran, carrying the harness label. Cursor's JSON result does carry a
 * `session_id`, but its hooks name the session by `conversation_id`, and
 * nothing documents the two as the same value, so it is not parsed.
 */
function headlessTurn(
  harness: TachoHarness,
  prompt: string,
): { args: string[]; parsesSession: boolean } {
  if (harness === "codex") {
    // No `--dangerously-bypass-hook-trust` here, deliberately. Codex has a
    // flag that runs untrusted hooks, and passing it would make this check
    // pass on a machine where every real session still runs unhooked —
    // which is the failure `verify` exists to catch. The trust records are
    // read before the turn instead (`codexTrustProblem` below), so an
    // untrusted machine is named as untrusted rather than proved by a flag
    // no real session uses.
    return {
      args: ["exec", "--skip-git-repo-check", prompt],
      parsesSession: false,
    };
  }
  if (harness === "cursor") {
    // `-p` (`--print`) runs one non-interactive turn (verified 2026-09-18
    // against https://cursor.com/docs/cli/reference/parameters, fetched that
    // day). The output is prose, so the session is matched the way Codex's
    // and Stella's are: a chain the daemon did not have before the turn ran,
    // carrying the harness label.
    return { args: ["-p", prompt], parsesSession: false };
  }
  if (harness === "stella") {
    return { args: ["run", prompt], parsesSession: false };
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
  /** Absent from a daemon older than the harness label on `/sessions`. */
  harness?: string;
  /**
   * SessionEnd arrived and the chain waits only for its final worktree read.
   * Absent from a daemon older than this field.
   */
  ending?: boolean;
}

function factsFor(harness: TachoHarness, deps: CliDeps) {
  if (harness === "codex") return deps.codex();
  if (harness === "cursor") return deps.cursor();
  if (harness === "stella") return deps.stella();
  return deps.claude();
}

function configPathFor(harness: TachoHarness, deps: CliDeps): string {
  if (harness === "codex") return deps.paths.codexHooks;
  if (harness === "cursor") return deps.paths.cursorHooks.join(" or ");
  if (harness === "stella") return deps.readStellaHooks().path;
  return deps.paths.claudeSettings;
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
  const requested = options.harness ?? "claude-code";
  if (!isWrappedHarness(requested)) {
    // `verify` drives one headless turn and waits for a sealed chain. A
    // connected harness (ADR-078) is a GUI app with no headless mode and no
    // hook to fire, so there is nothing to drive and nothing to wait for.
    // Saying so beats reporting a failure the operator cannot act on.
    return {
      ok: false,
      detail: `${requested} is a connected app, not a wrapped harness: it has no hook to verify. Check it in the Oxagen app, which reads its MCP config and the gateway's own record.`,
    };
  }
  const harness: WrappedHarness = requested;
  const facts = factsFor(harness, deps);
  const name = BINARY[harness];
  if (facts.path === undefined)
    return { ok: false, detail: `\`${name}\` is not on PATH` };
  const turn = headlessTurn(harness, options.prompt ?? DEFAULT_PROMPT);
  // Codex skips a hook whose definition is not recorded as trusted in its
  // own config: every symptom of an untrusted
  // hook is a symptom of a missing one. Reading the records first turns a
  // timeout the operator cannot act on into a sentence that names the cause,
  // and costs nothing when they are in order. It is read-only — `enroll`
  // records trust, `verify` only reports on it.
  if (harness === "codex") {
    const untrusted = await codexTrustProblem({
      appServer: deps.codexAppServer,
      hooksPath: deps.paths.codexHooks,
      hookCommand: host.hook_command,
      enrollmentId: host.host_enrollment_id,
    });
    if (untrusted !== undefined) return { ok: false, detail: untrusted };
  }
  // Every chain the daemon already holds. A turn whose own session id cannot
  // be read is matched by what appears after it: the busiest chain is not the
  // newest one, and a sealed chain retained from a real session would
  // otherwise report success while this turn's hooks never fired.
  const priorListing = (await deps.daemonGet("/sessions")) as
    | { sessions?: DaemonSession[] }
    | undefined;
  if (priorListing?.sessions === undefined && !turn.parsesSession) {
    return {
      ok: false,
      detail:
        "tachod did not list its sessions, so this turn's chain could not be told from the ones already recorded",
    };
  }
  const before = new Set(
    (priorListing?.sessions ?? []).map((session) => session.session_uuid),
  );
  deps.out(
    `Running ${name} ${turn.args[0]} (one headless turn) with hooks installed...`,
  );
  const run = deps.execLong(facts.path, turn.args);
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
      // Fall through: a chain the daemon did not hold before this turn.
    }
  }
  let deadline =
    deps.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS[harness]);
  let graced = false;
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
            .filter(
              (s) =>
                !before.has(s.session_uuid) &&
                !isInternalSession(s.session_id) &&
                (s.harness === undefined || s.harness === harness),
            )
            .sort((a, b) => b.seq - a.seq)[0];
    if (found?.sealed === true) break;
    if (found?.ending === true && !graced) {
      graced = true;
      deadline += ENDING_GRACE_MS;
    }
    await deps.sleep(500);
  }
  if (found === undefined) {
    return {
      ok: false,
      ...(sessionId !== undefined ? { sessionId } : {}),
      detail: `the daemon never saw the session; are the hooks installed and is ${name} reading ${configPathFor(harness, deps)}?`,
    };
  }
  if (!found.sealed) {
    return {
      ok: false,
      sessionId: found.session_id,
      sessionUuid: found.session_uuid,
      seq: found.seq,
      detail: found.ending === true ? ENDING_DETAIL : UNSEALED_DETAIL[harness],
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
