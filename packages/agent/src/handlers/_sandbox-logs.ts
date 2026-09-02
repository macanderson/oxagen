// Capture a coding-session command's output to ClickHouse for the sandbox
// inspector's log console (spec: sandbox-session-lifecycle §7.2).
//
// Fired fire-and-forget from ModalSandboxWorkspace.exec (the agent's REAL bash
// commands), NOT from the shared exec handler — so internal FS ops (readFile,
// list, glob, grep, diff, recovery) never spam the console. Each command yields:
//   - one 'system'/'debug' line: the command echo + exit code + duration
//   - its stdout lines at level 'normal' (stream 'stdout')
//   - its stderr lines at level 'normal' (stream 'stderr')
// The inspector's Debug toggle filters on `level`.
import { insertSandboxLogs, type SandboxLogRow } from "@oxagen/telemetry";
import type { CapabilityContext } from "../types";

/** Per-stream tail cap so a chatty build can't insert thousands of rows. */
const MAX_LINES_PER_STREAM = 300;
const MAX_LINE_LEN = 4000;
const MAX_COMMAND_LEN = 2000;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Split a stream into bounded, tail-capped log rows. */
function streamRows(
  base: Omit<
    SandboxLogRow,
    | "stream"
    | "level"
    | "line"
    | "seq"
    | "command"
    | "exit_code"
    | "duration_ms"
  >,
  text: string,
  stream: "stdout" | "stderr",
  startSeq: number,
): SandboxLogRow[] {
  const all = text.split("\n");
  // Drop a single trailing empty line from the final newline.
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const kept =
    all.length > MAX_LINES_PER_STREAM
      ? all.slice(all.length - MAX_LINES_PER_STREAM)
      : all;
  return kept.map((line, i) => ({
    ...base,
    stream,
    level: "normal" as const,
    command: "",
    seq: startSeq + i,
    line: truncate(line, MAX_LINE_LEN),
    exit_code: null,
    duration_ms: null,
  }));
}

/**
 * Capture one command's output. Never throws — a log write must not fail a run.
 * Call as `void captureSandboxCommandLogs(...)` (fire-and-forget).
 */
export async function captureSandboxCommandLogs(
  ctx: CapabilityContext,
  sessionId: string,
  command: string,
  result: {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  },
  durationMs: number,
): Promise<void> {
  try {
    const ts = new Date().toISOString();
    const base = {
      org_id: ctx.orgId,
      workspace_id: ctx.workspaceId,
      session_id: sessionId,
      ts,
    };
    const cmd = truncate(command, MAX_COMMAND_LEN);

    // Command echo + result summary — the 'debug' channel (toggle ON to see it).
    const systemRow: SandboxLogRow = {
      ...base,
      stream: "system",
      level: "debug",
      command: cmd,
      seq: 0,
      line: `$ ${cmd}${result.timedOut ? " [timed out]" : ""}`,
      exit_code: result.exitCode,
      duration_ms: durationMs,
    };

    const stdoutRows = streamRows(base, result.stdout, "stdout", 1);
    const stderrRows = streamRows(
      base,
      result.stderr,
      "stderr",
      1 + stdoutRows.length,
    );

    await insertSandboxLogs([systemRow, ...stdoutRows, ...stderrRows]);
  } catch {
    // Best-effort telemetry; never fail a sandbox command on a log write.
  }
}
