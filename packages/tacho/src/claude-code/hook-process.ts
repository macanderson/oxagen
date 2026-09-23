/**
 * The hook process body: read the harness payload from stdin, answer on
 * stdout, always exit 0 with a JSON decision. Shared by the `tacho-hook`
 * executable and `tacho hook` (the compiled single binary is multi-call, so
 * the settings writers install `tacho hook --enrollment ... [--harness ...]`;
 * a custom agent runs `tacho hook --agent <name>`).
 */
import { tachoPaths } from "../host/paths";
import { ulid } from "../ids";
import { agentFromArgv, harnessFromArgv, runTachoHook } from "./hook-client";

/** The most stdin bytes one hook process reads before it stops waiting for more. */
export const MAX_HOOK_STDIN_BYTES = 8 * 1024 * 1024;

/**
 * The longest this process waits for the harness to finish writing and
 * close stdin. Well under the shortest command-hook timeout Claude Code
 * enforces on the events this binary answers (10s for `SessionStart`,
 * `UserPromptSubmit` and `Stop`; 15s for `PreToolUse`; 600s for
 * `PermissionRequest` — `COMMAND_HOOK_TIMEOUTS_S` in
 * `host/settings-writer.ts`), so a stdin that never closes still gets an
 * answer from this process instead of the harness timing the whole command
 * out itself with no output at all.
 */
export const STDIN_READ_DEADLINE_MS = 5_000;

interface StdinRead {
  text: string;
  /** The read stopped early on the size cap or the deadline, not a closed stream. */
  truncated: boolean;
}

/** What `readStdin` needs from its source: a Buffer stream it can also cut off. */
type StdinSource = AsyncIterable<Buffer> & { destroy?: () => void };

/**
 * Read stdin to completion, bounded on size and on time so neither a
 * runaway payload nor a harness that never closes the pipe holds this
 * process open past its own budget. `source` defaults to `process.stdin`; a
 * test passes a fake stream instead.
 *
 * Whatever arrived before the cap or the deadline is still returned:
 * `runTachoHook` answers from it regardless (an incomplete payload fails
 * its own JSON parse and is quarantined there, the same as any other
 * unreadable stdin), so a slow or oversized write still gets an answer
 * rather than no output at all.
 */
export async function readStdin(
  source: StdinSource = process.stdin,
  deadlineMs = STDIN_READ_DEADLINE_MS,
  maxBytes = MAX_HOOK_STDIN_BYTES,
): Promise<StdinRead> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflowed = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
    timer.unref?.();
  });
  const read = (async (): Promise<"done"> => {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        overflowed = true;
        break;
      }
      chunks.push(chunk);
    }
    return "done";
  })();
  const outcome = await Promise.race([read, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  const truncated = overflowed || outcome === "timeout";
  if (outcome === "timeout") {
    // Stop waiting on a pipe that never closes; otherwise the event loop
    // stays open on the abandoned read and this process never exits.
    source.destroy?.();
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export async function runHookProcess(
  argv: readonly string[] = process.argv,
): Promise<void> {
  try {
    // Generated here, at the moment stdin is read, not left to default
    // inside `runTachoHook`: this id is what lets a spool replay of this
    // same hook (after the live request times out on this process's own
    // side, not the daemon's) be recognised as the same invocation and
    // dropped rather than recorded a second time. See `HookRunDeps.hookId`.
    const hookId = ulid(Date.now());
    const { text: stdin, truncated } = await readStdin();
    const result = await runTachoHook({
      paths: tachoPaths(process.env),
      env: process.env,
      stdin,
      hookId,
      harness: harnessFromArgv(argv),
      ...(agentFromArgv(argv) !== undefined
        ? { agent: agentFromArgv(argv) as string }
        : {}),
      platform: process.platform,
    });
    if (truncated) {
      process.stderr.write(
        "tacho-hook: stdin did not finish within the read budget; answering from what arrived\n",
      );
    }
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(
      `tacho-hook: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stdout.write("{}\n");
    process.exitCode = 0;
  }
}
