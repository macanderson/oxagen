/**
 * Memory uses: the memory files a Claude Code run read, counted on this host
 * and reported to the control plane's `/v1/tacho/memories/uses`
 * (`record_tacho_memory_uses`, ADR-245), with the files each complete memory
 * scan found.
 *
 * A use is one run reading one memory file. The hook handler hands each
 * `PostToolUse` of a Claude Code session to `memoryReadsOf`, which names the
 * memory files a `Read`, `Grep`, or `Bash` call read, and `note` queues each
 * one under the run's root session. Reading `MEMORY.md` is no use: Claude
 * Code loads that index at every session start, and it lists every memory.
 * The queue merges reads of one file in one run, so two reads make one use
 * with a count of two, and the API keeps one use per memory, run, and signal.
 *
 * `report` runs after each memory scan. It sends the queue in calls of at
 * most `MEMORY_USES_PER_REPORT` uses, then the rise in each count a harness
 * keeps itself (Codex's `usage_count`, `./memory-counts`) in calls of at most
 * `MEMORY_COUNTS_PER_REPORT`, then the scan's lists in a call of their own,
 * so a refused list never costs a use. A use whose run the API has not
 * recorded yet comes back `pending`, and waits for the next report, for a
 * day at most. Uses still queued when the daemon stops are lost: a use is a
 * count, and losing a few between reports skews no ranking. A count's rise
 * is not queued: each report works it out again from the store until the
 * control plane takes it.
 */
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { FetchLike } from "../../host/control-client";
import type { TachoHarness } from "../../wire";
import type { UseCountLedger } from "./memory-counts";
import type {
  HarnessMemoryLocation,
  HarnessUseCounts,
  MemoryScan,
} from "./memory-reader";

export const MEMORY_USES_PATH = "/v1/tacho/memories/uses";

// The limits below mirror `record_tacho_memory_uses`
// (packages/oxagen/src/contracts/tacho.memories.uses.record.ts), which this
// leaf package cannot import.
/** The most uses one call carries. */
export const MEMORY_USES_PER_REPORT = 200;
/** The most harness counts one call carries. */
export const MEMORY_COUNTS_PER_REPORT = 200;
/** The most memory files one scan names. A larger scan is not sent. */
export const MEMORY_SCAN_PATHS_MAX = 4_000;
/** The most scans one call carries. */
export const MEMORY_SCANS_PER_REPORT = 8;
/** The largest count one use carries. */
export const MEMORY_USE_COUNT_MAX = 10_000;

/** The most uses the queue holds between reports. */
export const MEMORY_USES_QUEUED_MAX = 2_000;
/** How long a pending use waits for its run before it is dropped. */
export const MEMORY_USE_PENDING_MAX_MS = 24 * 60 * 60_000;

/** How long one call may take before it is abandoned. */
const MEMORY_USES_TIMEOUT_MS = 15_000;

/** Answers that refuse one call's content rather than every call. */
const CALL_REFUSED: ReadonlySet<number> = new Set([400, 413, 422]);

/** The longest Bash command the scan reads, so a huge heredoc costs nothing. */
const BASH_COMMAND_MAX_CHARS = 100_000;

/** One memory file, as a memory's source names it. */
export interface MemoryFile {
  harness: TachoHarness;
  /** The file's absolute path, normalized. */
  path: string;
}

/**
 * The memory file `path` names, or undefined when it is none. A memory file
 * is `<projectsDir(home)>/<project>/<memoryDir>/<name><extension>`, or
 * `<projectsDir(home)>/<subagent>/<name><extension>` where `memoryDir` is
 * empty, and its name is not one the location skips, so `MEMORY.md` never is
 * one. The path is normalized first, so `..` and doubled separators compare
 * equal.
 */
export function memoryFileOf(
  path: string,
  locations: readonly HarnessMemoryLocation[],
  home: string,
): MemoryFile | undefined {
  if (!isAbsolute(path)) return undefined;
  const file = resolve(path);
  const name = basename(file);
  const folder = dirname(file);
  for (const location of locations) {
    if (!name.endsWith(location.extension)) continue;
    if (location.skip.includes(name)) continue;
    const projectDir = location.memoryDir === "" ? folder : dirname(folder);
    if (location.memoryDir !== "" && basename(folder) !== location.memoryDir)
      continue;
    if (dirname(projectDir) !== resolve(location.projectsDir(home))) continue;
    return { harness: location.harness, path: file };
  }
  return undefined;
}

/**
 * A word as a path: a leading `~/`, `$HOME/`, or `${HOME}/` becomes `home`,
 * and a relative word resolves against `cwd` when `cwd` is absolute.
 */
function pathOf(
  word: string,
  cwd: string | undefined,
  home: string,
): string | undefined {
  const expanded = /^(?:~|\$HOME|\$\{HOME\})\//.test(word)
    ? join(home, word.slice(word.indexOf("/") + 1))
    : word;
  if (isAbsolute(expanded)) return expanded;
  if (cwd !== undefined && isAbsolute(cwd)) return resolve(cwd, expanded);
  return undefined;
}

/** A tool input member as a string, or undefined. */
function stringMember(
  input: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The memory files one Claude Code tool call read, each once.
 *
 * - `Read` reads `file_path`.
 * - `Grep` reads `path` when it names a memory file. A search of a folder is
 *   no use of each file in it.
 * - `Bash` reads each word of `command` that names a memory file. The words
 *   split on whitespace, on `;|&<>()'"` and the backtick, and on `=`. The
 *   scan does not see a glob (`memory/*.md`), a variable other than `HOME`,
 *   or a path the command builds as it runs.
 *
 * Any other tool reads none.
 */
export function memoryReadsOf(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  cwd: string | undefined,
  home: string,
  locations: readonly HarnessMemoryLocation[],
): MemoryFile[] {
  let words: string[];
  if (toolName === "Read")
    words = [stringMember(toolInput, "file_path") ?? ""];
  else if (toolName === "Grep")
    words = [stringMember(toolInput, "path") ?? ""];
  else if (toolName === "Bash")
    words = (stringMember(toolInput, "command") ?? "")
      .slice(0, BASH_COMMAND_MAX_CHARS)
      .split(/[\s;|&<>()'"`=]+/);
  else return [];
  const files = new Map<string, MemoryFile>();
  for (const word of words) {
    // A word with a glob character names no one file.
    if (word.length === 0 || /[*?[]/.test(word)) continue;
    const path = pathOf(word, cwd, home);
    if (path === undefined) continue;
    const file = memoryFileOf(path, locations, home);
    if (file !== undefined) files.set(`${file.harness}\n${file.path}`, file);
  }
  return [...files.values()];
}

/** One read the hook handler saw. */
export interface MemoryRead extends MemoryFile {
  /** The root session of the run that read the file. */
  sessionUuid: string;
  /** When the hook arrived, as an ISO 8601 timestamp. */
  at: string;
}

/** One use as the queue holds it until a report sends it. */
interface QueuedUse {
  harness: TachoHarness;
  path: string;
  sessionUuid: string;
  count: number;
  usedAt: string;
}

export interface MemoryUsesDeps {
  /** Read at every call, so a renewed key is the one used. */
  host: () => {
    api_url: string;
    api_key: string;
    host_enrollment_id: string;
  };
  fetch: FetchLike;
  log: (line: string) => void;
  now: () => number;
  timeoutMs?: number;
  /**
   * The counts each harness that counts its own uses held at the last
   * report. Without it, `report` sends no harness count.
   */
  counts?: UseCountLedger;
}

export interface MemoryUses {
  /** Queue one read. It never waits and never throws. */
  note: (read: MemoryRead) => void;
  /**
   * Send the queued uses, then the rise in each of `counts`, then `scans`.
   * A report that overlaps one still running joins it, and that report's
   * own scans and counts wait for the next scan to read them again. It
   * never throws.
   */
  report: (
    scans?: readonly MemoryScan[],
    counts?: readonly HarnessUseCounts[],
  ) => Promise<void>;
  /** How many uses wait in the queue. */
  size: () => number;
}

/** What one call to the control plane came to. */
type CallResult =
  | { kind: "taken"; pending: number[] }
  | { kind: "refused"; status: number }
  | { kind: "kept" };

const keyOf = (use: Pick<QueuedUse, "harness" | "path" | "sessionUuid">) =>
  `${use.harness}\n${use.sessionUuid}\n${use.path}`;

/** The later of two ISO 8601 timestamps. */
function later(a: string, b: string): string {
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** The `pending` indexes of an answer, or none when the answer has none. */
function pendingOf(text: string, sentCount: number): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const pending =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { pending?: unknown }).pending
      : undefined;
  if (!Array.isArray(pending)) return [];
  return pending.filter(
    (index): index is number =>
      Number.isInteger(index) && index >= 0 && index < sentCount,
  );
}

export function createMemoryUses(deps: MemoryUsesDeps): MemoryUses {
  const queue = new Map<string, QueuedUse>();
  let overflowed = 0;
  let routeMissingLogged = false;
  let oversizeLogged = false;
  // The last failure logged. A failure is logged when it changes, not at
  // every report, and a success clears it.
  let lastFailure: string | undefined;
  let running: Promise<void> | undefined;

  /** Put a use back in the queue, merged with any newer read of the same file. */
  function requeue(use: QueuedUse): void {
    const key = keyOf(use);
    const queued = queue.get(key);
    if (queued !== undefined) {
      queued.count = Math.min(queued.count + use.count, MEMORY_USE_COUNT_MAX);
      queued.usedAt = later(queued.usedAt, use.usedAt);
      return;
    }
    if (queue.size >= MEMORY_USES_QUEUED_MAX) {
      overflowed += 1;
      return;
    }
    queue.set(key, { ...use });
  }

  function failure(detail: string): void {
    if (detail === lastFailure) return;
    lastFailure = detail;
    deps.log(`memory uses: ${detail}; the uses wait for the next report`);
  }

  async function call(
    body: Record<string, unknown>,
    uses: number,
  ): Promise<CallResult> {
    const host = deps.host();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      deps.timeoutMs ?? MEMORY_USES_TIMEOUT_MS,
    );
    let response: Awaited<ReturnType<FetchLike>>;
    let text: string;
    try {
      response = await deps.fetch(
        `${host.api_url.replace(/\/$/, "")}${MEMORY_USES_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${host.api_key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            host_enrollment_id: host.host_enrollment_id,
            ...body,
          }),
          signal: controller.signal,
        },
      );
      // Read to the end, so the connection is free for the next call.
      text = await response.text();
    } catch (error) {
      failure(
        `the control plane is unreachable (${error instanceof Error ? error.message : String(error)})`,
      );
      return { kind: "kept" };
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      lastFailure = undefined;
      return { kind: "taken", pending: pendingOf(text, uses) };
    }
    if (response.status === 404) {
      if (!routeMissingLogged) {
        routeMissingLogged = true;
        deps.log(
          `memory uses: the control plane has no ${MEMORY_USES_PATH} route yet; the uses wait until it does`,
        );
      }
      return { kind: "kept" };
    }
    if (CALL_REFUSED.has(response.status))
      return { kind: "refused", status: response.status };
    failure(`the control plane answered ${response.status}`);
    return { kind: "kept" };
  }

  async function reportOnce(
    scans: readonly MemoryScan[] | undefined,
    counts: readonly HarnessUseCounts[] | undefined,
  ): Promise<void> {
    if (overflowed > 0) {
      deps.log(
        `memory uses: the queue was full, so ${overflowed} memory reads were not counted`,
      );
      overflowed = 0;
    }
    // Taken out of the queue before the call, so a read noted while the call
    // runs starts a new use rather than one the answer then removes.
    const taken = [...queue.values()];
    queue.clear();
    for (let start = 0; start < taken.length; start += MEMORY_USES_PER_REPORT) {
      const batch = taken.slice(start, start + MEMORY_USES_PER_REPORT);
      const result = await call(
        {
          uses: batch.map((use) => ({
            harness: use.harness,
            path: use.path,
            session_uuid: use.sessionUuid,
            count: use.count,
            used_at: use.usedAt,
          })),
        },
        batch.length,
      );
      if (result.kind === "kept") {
        // Every call after this one would fail the same way, so this batch
        // and the rest wait for the next report, and so do the scans.
        for (const use of taken.slice(start)) requeue(use);
        return;
      }
      if (result.kind === "refused") {
        deps.log(
          `memory uses: the control plane refused ${batch.length} uses (${result.status}); they are dropped`,
        );
        continue;
      }
      const oldest = deps.now() - MEMORY_USE_PENDING_MAX_MS;
      for (const index of result.pending) {
        const use = batch[index];
        if (use !== undefined && Date.parse(use.usedAt) >= oldest) requeue(use);
      }
    }
    const rises =
      deps.counts !== undefined && counts !== undefined && counts.length > 0
        ? deps.counts.rises(counts)
        : [];
    for (let start = 0; start < rises.length; start += MEMORY_COUNTS_PER_REPORT) {
      const batch = rises.slice(start, start + MEMORY_COUNTS_PER_REPORT);
      const result = await call(
        {
          counts: batch.map((rise) => ({
            harness: rise.harness,
            path: rise.path,
            count: rise.count,
            used_at: rise.usedAt,
          })),
        },
        0,
      );
      // The rises not settled are worked out again at the next report, and
      // the scans wait with them.
      if (result.kind === "kept") return;
      // A refused call would be refused again, so its rises settle and are
      // lost. The memories keep the counts reported before.
      if (result.kind === "refused")
        deps.log(
          `memory uses: the control plane refused ${batch.length} harness counts (${result.status}); they are dropped`,
        );
      deps.counts?.settle(batch);
    }
    const lists = (scans ?? []).filter(
      (scan) => scan.paths.length <= MEMORY_SCAN_PATHS_MAX,
    );
    if (lists.length < (scans ?? []).length && !oversizeLogged) {
      oversizeLogged = true;
      deps.log(
        `memory uses: a scan found more than ${MEMORY_SCAN_PATHS_MAX} memory files, so it is not sent and no deleted file retires its memory`,
      );
    }
    for (let start = 0; start < lists.length; start += MEMORY_SCANS_PER_REPORT) {
      const result = await call(
        { scans: lists.slice(start, start + MEMORY_SCANS_PER_REPORT) },
        0,
      );
      if (result.kind === "kept") return;
      if (result.kind === "refused")
        deps.log(
          `memory uses: the control plane refused a scan's file list (${result.status})`,
        );
    }
  }

  return {
    note: (read) => {
      const key = keyOf(read);
      const queued = queue.get(key);
      if (queued !== undefined) {
        queued.count = Math.min(queued.count + 1, MEMORY_USE_COUNT_MAX);
        queued.usedAt = later(queued.usedAt, read.at);
        return;
      }
      if (queue.size >= MEMORY_USES_QUEUED_MAX) {
        overflowed += 1;
        return;
      }
      queue.set(key, {
        harness: read.harness,
        path: read.path,
        sessionUuid: read.sessionUuid,
        count: 1,
        usedAt: read.at,
      });
    },
    report: (scans, counts) => {
      running ??= reportOnce(scans, counts)
        .catch((error: unknown) => {
          deps.log(
            `memory uses: the report failed (${error instanceof Error ? error.message : String(error)})`,
          );
        })
        .finally(() => {
          running = undefined;
        });
      return running;
    },
    size: () => queue.size,
  };
}
