/**
 * Which `claude` processes are running on this host. Feeds the unobserved
 * session detector (spec section 11) and the `cancel` command's kill (7.4).
 * Uses `ps` through the `Exec` port so tests supply a fixed listing.
 */
import type { Exec } from "./service";

export interface ClaudeProcess {
  pid: number;
  ppid: number;
  command: string;
  /** Present when the command line carries an explicit `--resume`/`-r`. */
  resumeArg?: string;
}

const CLAUDE_BINARY = /(^|\/)claude(\s|$)/;
const CLAUDE_VERSIONS_DIR = /\/claude\/versions\/\d+\.\d+\.\d+/;

export function parsePsListing(listing: string): ClaudeProcess[] {
  const out: ClaudeProcess[] = [];
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const command = (match[3] ?? "").trim();
    const first = command.split(/\s+/, 1)[0] ?? "";
    if (!CLAUDE_BINARY.test(first) && !CLAUDE_VERSIONS_DIR.test(first))
      continue;
    const resume = /(?:--resume|-r)(?:=|\s+)([^\s]+)/.exec(command);
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command,
      ...(resume?.[1] !== undefined ? { resumeArg: resume[1] } : {}),
    });
  }
  return out;
}

export function listClaudeProcesses(exec: Exec): ClaudeProcess[] {
  const result = exec("ps", ["-axo", "pid=,ppid=,command="]);
  if (result.status !== 0) return [];
  return parsePsListing(result.stdout);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
