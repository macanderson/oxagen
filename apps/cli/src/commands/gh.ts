/**
 * Shared `gh` CLI invocation helper.
 *
 * Centralizes what every `gh` caller in the CLI needs:
 *   - a color-safe env. Some shells force ANSI color on `gh` regardless of TTY
 *     (`CLICOLOR_FORCE=1` in the profile, or `gh config set color always`) —
 *     that corrupts `--json`/`gh api` output with escape codes and breaks
 *     `JSON.parse`. Every call here pins color off so structured output is
 *     always clean, independent of the caller's shell.
 *   - one execFile wrapper so callers don't each re-derive maxBuffer/env.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/** Env overlay that defeats every color-forcing mechanism `gh` respects. */
export function colorSafeEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    NO_COLOR: "1",
    CLICOLOR_FORCE: "0",
    CLICOLOR: "0",
    FORCE_COLOR: "0",
  };
}

export interface RunGhOptions {
  cwd?: string;
  maxBuffer?: number;
}

/** Run `gh <args>` with a color-safe env. Throws (with gh's stderr in the message) on non-zero exit. */
export async function runGh(
  args: string[],
  opts: RunGhOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("gh", args, {
    cwd: opts.cwd,
    env: colorSafeEnv(),
    maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
  });
}

/** Run `gh <args>` and JSON.parse stdout — the `--json`/`api` call shape almost every caller wants. */
export async function ghJson<T>(
  args: string[],
  opts: RunGhOptions = {},
): Promise<T> {
  const { stdout } = await runGh(args, opts);
  return JSON.parse(stdout) as T;
}
