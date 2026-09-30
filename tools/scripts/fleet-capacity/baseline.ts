import { createReadStream } from "node:fs";
import { lstat, opendir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { eventHashHolds, GENESIS_PREV_HASH } from "../../../packages/tacho/src/chain";
import { parseTachoEvent } from "../../../packages/tacho/src/envelope";

export type Coverage = "wal-subset" | "unacknowledged-backlog" | "operator-attested-complete" | "synthetic";
export interface BaselineOptions {
  from: string;
  to: string;
  coverage: Coverage;
  maxLineBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  maxDurationMs?: number;
}

/** Fixed bins retain numeric counts without retaining values or identifiers. */
class Distribution {
  private bins = Array<number>(54).fill(0);
  count = 0;
  min: number | null = null;
  max: number | null = null;
  sum = 0;
  add(value: number): void {
    const bin = value === 0 ? 0 : Math.min(53, Math.ceil(Math.log2(value)) + 1);
    this.bins[bin]!++;
    this.count++;
    this.min = Math.min(this.min ?? value, value);
    this.max = Math.max(this.max ?? value, value);
    this.sum += value;
  }
  report() {
    const quantile = (p: number) => {
      if (!this.count) return null;
      let count = 0;
      for (let index = 0; index < this.bins.length; index++) {
        count += this.bins[index]!;
        if (count >= Math.ceil(this.count * p)) return Math.min(this.max!, index === 0 ? 0 : 2 ** (index - 1));
      }
      return this.max;
    };
    return { count: this.count, min: this.min, max: this.max, mean: this.count ? this.sum / this.count : null,
      p50Upper: quantile(0.5), p95Upper: quantile(0.95), p99Upper: quantile(0.99) };
  }
}

/** Read at most one line plus a 64 KiB chunk. The size is the snapshot's initial size. */
export async function* boundedLines(path: string, size: number, maxLineBytes: number): AsyncGenerator<{ text: string; bytes: number; terminated: boolean }> {
  finiteLimit(maxLineBytes, 4 * 1024 * 1024);
  if (size === 0) return;
  finiteLimit(size, 128 * 1024 ** 3);
  const input = createReadStream(path, { highWaterMark: 64 * 1024, start: 0, end: size - 1 });
  const line = Buffer.alloc(maxLineBytes);
  let used = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const value of input) {
      const chunk = value as Buffer;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline === -1 ? chunk.length : newline;
        const length = end - offset;
        if (used + length > maxLineBytes) throw new Error("A baseline record exceeds the line-byte limit.");
        chunk.copy(line, used, offset, end);
        used += length;
        if (newline === -1) break;
        yield { text: decoder.decode(line.subarray(0, used)), bytes: used, terminated: true };
        used = 0;
        offset = newline + 1;
      }
    }
    if (used) yield { text: decoder.decode(line.subarray(0, used)), bytes: used, terminated: false };
  } finally { input.destroy(); }
}

function finiteLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error("Invalid baseline resource limit.");
  return value;
}

/** Read an offline copy of one host's WAL. Body sidecars and cursor files are never opened. */
export async function collectBaseline(directory: string, options: BaselineOptions) {
  const from = Date.parse(options.from);
  const to = Date.parse(options.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 7 * 86400000)
    throw new Error("Baseline window must be positive and at most seven days.");
  if (!["wal-subset", "unacknowledged-backlog", "operator-attested-complete", "synthetic"].includes(options.coverage))
    throw new Error("Unknown baseline coverage label.");
  const maxLineBytes = finiteLimit(options.maxLineBytes ?? 4 * 1024 * 1024, 4 * 1024 * 1024);
  const maxTotalBytes = finiteLimit(options.maxTotalBytes ?? 128 * 1024 ** 3, 128 * 1024 ** 3);
  const maxFiles = finiteLimit(options.maxFiles ?? 100000, 100000);
  const duration = finiteLimit(options.maxDurationMs ?? 30 * 60000, 30 * 60000);
  const deadline = Date.now() + duration;
  const hourCount = Math.ceil((to - from) / 3600000);
  const hours = Array.from({ length: hourCount }, (_, index) => ({ offsetHours: index,
    seconds: Math.min(3600000, to - from - index * 3600000) / 1000,
    events: 0, eventBytes: 0, sessionStarts: 0, modelCalls: 0, toolCalls: 0 }));
  const totals = { events: 0, eventBytes: 0, sessionStarts: 0, modelCalls: 0, toolCalls: 0, turnStarts: 0,
    files: 0, scannedEntries: 0, ignoredEntries: 0, scannedBytes: 0, outsideWindowEvents: 0,
    malformedLines: 0, unterminatedLines: 0, chainErrors: 0, changedFiles: 0,
    completeSessions: 0, partialOrCrossBoundarySessions: 0, unsupportedRigSessions: 0 };
  const eventBytes = new Distribution();
  const eventsPerSession = new Distribution();
  const turnsPerSession = new Distribution();
  const sessionDurationMs = new Distribution();
  const rigTurns = Array<number>(31).fill(0);
  const dir = await opendir(directory, { bufferSize: 32 });
  for await (const entry of dir) {
    if (Date.now() >= deadline) throw new Error("Baseline collection exceeded its read deadline.");
    if (++totals.scannedEntries > maxFiles * 4) throw new Error("Baseline directory exceeds the entry limit.");
    if (!entry.isFile() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.ndjson$/i.test(entry.name)) {
      totals.ignoredEntries++; continue;
    }
    if (++totals.files > maxFiles) throw new Error("Baseline input exceeds the file limit.");
    const path = join(directory, entry.name);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Baseline input changed file type.");
    totals.scannedBytes += before.size;
    if (totals.scannedBytes > maxTotalBytes) throw new Error("Baseline input exceeds the total-byte limit.");
    let session: string | undefined;
    let previousHash: string = GENESIS_PREV_HASH;
    let previousSeq = -1;
    let firstTime: number | undefined;
    let lastTime: number | undefined;
    let firstKind: string | undefined;
    let lastKind: string | undefined;
    let sessionEvents = 0;
    let sessionTurns = 0;
    let invalid = false;
    let touchesWindow = false;
    for await (const line of boundedLines(path, before.size, maxLineBytes)) {
      if (Date.now() >= deadline) throw new Error("Baseline collection exceeded its read deadline.");
      if (!line.text.trim()) continue;
      if (!line.terminated) { totals.unterminatedLines++; invalid = true; }
      let event: ReturnType<typeof parseTachoEvent>;
      try { event = parseTachoEvent(JSON.parse(line.text)); } catch { totals.malformedLines++; invalid = true; continue; }
      if (event.session_uuid.toLowerCase() !== entry.name.slice(0, -7).toLowerCase()) {
        totals.malformedLines++; invalid = true; continue;
      }
      const time = Date.parse(event.ts);
      if (!Number.isFinite(time)) { totals.malformedLines++; invalid = true; continue; }
      const inWindow = time >= from && time < to;
      touchesWindow ||= inWindow;
      if ((session !== undefined && event.session_uuid !== session) || event.seq !== previousSeq + 1 ||
          event.prev_hash !== previousHash || !eventHashHolds(event as unknown as Record<string, unknown>, event.hash)) {
        totals.chainErrors++; invalid = true;
      }
      session ??= event.session_uuid;
      firstTime ??= time;
      firstKind ??= event.kind;
      if (lastTime !== undefined && time < lastTime) invalid = true;
      lastTime = time; lastKind = event.kind; previousSeq = event.seq; previousHash = event.hash;
      sessionEvents++;
      if (event.kind === "turn_start") sessionTurns++;
      if (!inWindow) { totals.outsideWindowEvents++; continue; }
      totals.events++; totals.eventBytes += line.bytes;
      const hour = hours[Math.floor((time - from) / 3600000)]!;
      hour.events++; hour.eventBytes += line.bytes;
      eventBytes.add(line.bytes);
      if (event.kind === "agent_start") { totals.sessionStarts++; hour.sessionStarts++; }
      if (event.kind === "llm_call") { totals.modelCalls++; hour.modelCalls++; }
      if (event.kind === "tool_call") { totals.toolCalls++; hour.toolCalls++; }
      if (event.kind === "turn_start") totals.turnStarts++;
    }
    const after = await lstat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      totals.changedFiles++; invalid = true;
    }
    const complete = !invalid && firstKind === "agent_start" && lastKind === "agent_stop" &&
      firstTime !== undefined && lastTime !== undefined && firstTime >= from && lastTime < to;
    if (complete) {
      totals.completeSessions++;
      eventsPerSession.add(sessionEvents); turnsPerSession.add(sessionTurns); sessionDurationMs.add(lastTime! - firstTime!);
      if (sessionTurns >= 1 && sessionTurns <= 30) rigTurns[sessionTurns]!++;
      else totals.unsupportedRigSessions++;
    } else if (touchesWindow) totals.partialOrCrossBoundarySessions++;
  }
  const rate = (count: number, seconds: number) => count / seconds;
  const seconds = (to - from) / 1000;
  const days = Array.from({ length: Math.ceil(hourCount / 24) }, (_, index) => {
    const window = hours.slice(index * 24, (index + 1) * 24);
    const daySeconds = window.reduce((sum, hour) => sum + hour.seconds, 0);
    const events = window.reduce((sum, hour) => sum + hour.events, 0);
    const starts = window.reduce((sum, hour) => sum + hour.sessionStarts, 0);
    return { offsetDays: index, seconds: daySeconds, events, sessionStarts: starts,
      eventsPerSecond: rate(events, daySeconds), sessionsPerSecond: rate(starts, daySeconds) };
  });
  const maximumWeight = Math.max(...rigTurns);
  const divisor = Math.max(1, Math.ceil(maximumWeight / 100000));
  return {
    schema: "fleet-baseline/v1", windowStartUnixMs: from, windowEndUnixMs: to, windowSeconds: seconds,
    coverage: { declared: options.coverage, independentlyVerified: false, representativeProducedWindow: false,
      includesAcknowledgedEvents: "unknown", includesUnacknowledgedEvents: "unknown" },
    ...totals,
    observedRates: { eventsPerSecond: rate(totals.events, seconds), eventBytesPerSecond: rate(totals.eventBytes, seconds),
      sessionsPerSecond: rate(totals.sessionStarts, seconds), modelCallsPerSecond: rate(totals.modelCalls, seconds),
      toolCallsPerSecond: rate(totals.toolCalls, seconds) },
    hours: hours.map((hour) => ({ ...hour, eventsPerSecond: rate(hour.events, hour.seconds),
      sessionsPerSecond: rate(hour.sessionStarts, hour.seconds) })), days,
    distributions: { eventRecordBytes: eventBytes.report(), completeSessionEvents: eventsPerSession.report(),
      completeSessionTurns: turnsPerSession.report(), completeSessionDurationMs: sessionDurationMs.report() },
    rigBaselineDraft: { measured: false, sourceKind: "produced", source: "Offline WAL numeric summary with unverified coverage",
      sessionsPerSecond: rate(totals.sessionStarts, seconds), weightsDividedBy: divisor,
      samples: rigTurns.flatMap((count, turns) => count ? [{ turns, weight: Math.max(1, Math.round(count / divisor)) }] : []) },
    missingMetrics: ["Representative busy-hour and full-day producer coverage cannot be proved from retained WAL files.",
      "Body-byte distribution is unavailable because evidence sidecars are not read; draft samples omit bodyBytes.",
      "Request bytes, requests per second, acknowledgment status, retries, and backlog age need shipping records or a verified cursor snapshot.",
      "Concurrent session distribution, enrichment work, provider calls, and resource use need independent observations.",
      "The rig draft uses complete sessions within the window; censored and unsupported sessions need separate workload coverage."] };
}

export async function baselineMain(args: string[]): Promise<void> {
  const [directory, from, to, output, coverage = "wal-subset"] = args;
  if (!directory || !from || !to || !output) throw new Error("Usage: baseline.ts snapshot-directory from-ISO to-ISO output.json [coverage]");
  const report = await collectBaseline(directory, { from, to, coverage: coverage as Coverage });
  await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  baselineMain(process.argv.slice(2)).catch(() => {
    process.stderr.write("Baseline collection failed. No source records or identifiers were printed.\n");
    process.exitCode = 1;
  });
}
