/**
 * `oxagen agent backfill`: rebuild the Claude Code sessions this machine ran
 * before it enrolled, from the transcripts Claude Code kept (ADR-161,
 * `docs/specs/tacho/backfill.md` section 7).
 *
 * The command does no reading itself. It asks the running daemon over its
 * socket, because the daemon owns the host key, the recorders, the WAL and
 * the shipper, and a second writer would race it. It prints the daemon's
 * report: counts, project directory names, and dates. No prompt, message,
 * title, tool input, or path from inside a transcript reaches stdout.
 *
 * Exit codes: 0 the pass finished, 1 it stopped before the end, 2 an option
 * is invalid, 3 no daemon is running, 4 this machine is not enrolled.
 */
import {
  BACKFILL_ACTIONS,
  type BackfillReport,
  type BackfillRequest,
  parseBackfillRequest,
} from "../collector/backfill";
import { readHostFile } from "../host/host-file";
import type { CliDeps } from "./deps";

export const BACKFILL_EXIT = {
  finished: 0,
  stopped: 1,
  invalid: 2,
  noDaemon: 3,
  notEnrolled: 4,
} as const;

export interface BackfillCommandOptions {
  since?: string;
  until?: string;
  project?: string[];
  excludeProject?: string[];
  session?: string[];
  dryRun?: boolean;
  json?: boolean;
}

/** How often a progress line prints, at most. */
const PROGRESS_EVERY_MS = 5_000;

/** The words each session action prints as. */
const ACTION_LABELS: Record<(typeof BACKFILL_ACTIONS)[number], string> = {
  backfilled: "Backfilled",
  skipped_local_chain: "Skipped: this machine records it live",
  skipped_server_chain: "Skipped: Oxagen holds its live record",
  skipped_already_backfilled: "Skipped: already backfilled",
  skipped_older_normalizer: "Skipped: backfilled by an older version",
  skipped_active: "Skipped: written in the last 15 minutes",
  skipped_server_unanswered: "Skipped: Oxagen did not answer",
  skipped_empty: "Skipped: no timed records",
  failed: "Failed",
};

/** Run the command and answer its exit code. */
export async function backfillCommand(
  options: BackfillCommandOptions,
  deps: CliDeps,
): Promise<number> {
  const parsed = parseBackfillRequest(requestOf(options));
  if ("error" in parsed) {
    deps.err(parsed.error);
    return BACKFILL_EXIT.invalid;
  }
  let enrolled: boolean;
  try {
    enrolled = readHostFile(deps.paths.hostFile) !== undefined;
  } catch {
    enrolled = false;
  }
  if (!enrolled) {
    deps.err(
      "This machine is not enrolled, so it has nowhere to send a backfill. Run `oxagen agent enroll` first.",
    );
    return BACKFILL_EXIT.notEnrolled;
  }
  if (deps.daemonStream === undefined) {
    deps.err("This build cannot reach the daemon for a backfill.");
    return BACKFILL_EXIT.noDaemon;
  }
  // Filled by the stream's lines as they arrive.
  const got: { report?: BackfillReport; refusal?: string } = {};
  let printedAt = 0;
  const answer = await deps.daemonStream(
    "/backfill",
    parsed.request,
    (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message["report"] !== undefined) {
        got.report = message["report"] as BackfillReport;
        return;
      }
      if (typeof message["error"] === "string") {
        got.refusal = message["error"];
        return;
      }
      const progress = message["progress"] as BackfillReport | undefined;
      if (progress === undefined || options.json === true) return;
      const now = Date.now();
      if (now - printedAt < PROGRESS_EVERY_MS) return;
      printedAt = now;
      deps.out(progressLine(progress));
    },
  );
  if (answer === undefined) {
    deps.err(
      "The Oxagen daemon did not answer, so nothing was read. Run `oxagen agent status` to see why, then run this command again.",
    );
    return BACKFILL_EXIT.noDaemon;
  }
  if (answer.status !== 200) {
    deps.err(
      got.refusal ?? `The daemon refused the backfill (status ${answer.status}).`,
    );
    return answer.status === 400 ? BACKFILL_EXIT.invalid : BACKFILL_EXIT.stopped;
  }
  const done = got.report;
  if (done === undefined) {
    deps.err(
      "The daemon stopped before the pass finished. Run the command again to resume from where it stopped.",
    );
    return BACKFILL_EXIT.stopped;
  }
  if (options.json === true) deps.out(JSON.stringify(done));
  else for (const line of reportLines(done)) deps.out(line);
  if (!done.finished) {
    if (options.json !== true)
      deps.err(
        done.stopped === "error"
          ? "The pass stopped on an error. The daemon's log names it. Run the command again to resume."
          : "The pass stopped before the end. Run the command again to resume from where it stopped.",
      );
    return BACKFILL_EXIT.stopped;
  }
  return BACKFILL_EXIT.finished;
}

function requestOf(options: BackfillCommandOptions): BackfillRequest {
  return {
    ...(options.since !== undefined ? { since: options.since } : {}),
    ...(options.until !== undefined ? { until: options.until } : {}),
    ...(options.project !== undefined && options.project.length > 0
      ? { projects: options.project }
      : {}),
    ...(options.excludeProject !== undefined && options.excludeProject.length > 0
      ? { excludeProjects: options.excludeProject }
      : {}),
    ...(options.session !== undefined && options.session.length > 0
      ? { sessions: options.session }
      : {}),
    ...(options.dryRun === true ? { dryRun: true } : {}),
  };
}

const number = (value: number): string => value.toLocaleString("en-US");

function sum(values: Record<string, number> | undefined): number {
  return Object.values(values ?? {}).reduce((total, value) => total + value, 0);
}

/**
 * A progress line from the daemon. The daemon can be a different build from
 * this CLI, so a count it does not send reads as zero rather than throwing.
 */
function progressLine(report: Partial<BackfillReport>): string {
  const sessions = sum(report.sessions);
  return `Progress: ${number(sessions)} sessions read, ${number(report.sessions?.backfilled ?? 0)} backfilled, ${number(sum(report.frames))} frames`;
}

/** The report as the lines a person reads. Counts only. */
function reportLines(report: BackfillReport): string[] {
  const lines: string[] = [];
  lines.push(
    report.dry_run
      ? `Dry run with normalizer ${report.normalizer_version}. Nothing was sealed or sent.`
      : `Backfill with normalizer ${report.normalizer_version}.`,
  );
  lines.push("", "Projects");
  for (const project of report.projects) {
    const dates =
      project.first === undefined
        ? ""
        : project.first === project.last
          ? `  ${project.first}`
          : `  ${project.first} to ${project.last ?? project.first}`;
    lines.push(
      `  ${project.included ? "included" : "excluded"}  ${project.slug}  ${number(project.sessions)} sessions  ${number(project.subagents)} subagents${dates}`,
    );
  }
  if (report.projects.length === 0) lines.push("  none found");
  lines.push("", "Sessions");
  for (const action of BACKFILL_ACTIONS) {
    const count = report.sessions[action];
    if (count === 0 && action !== "backfilled") continue;
    const label =
      action === "backfilled" && report.dry_run
        ? "Would be backfilled"
        : ACTION_LABELS[action];
    lines.push(`  ${label}: ${number(count)}`);
  }
  lines.push("", "Frames");
  for (const [kind, count] of Object.entries(report.frames).sort())
    lines.push(`  ${kind}: ${number(count)}`);
  lines.push(`  Rebuilt from transcript records: ${number(report.synthesized)}`);
  lines.push("", "Tokens by model");
  const models = Object.entries(report.tokens).sort(([a], [b]) => a.localeCompare(b));
  for (const [model, classes] of models)
    lines.push(
      `  ${model}: ${Object.entries(classes)
        .map(([name, value]) => `${name} ${number(value)}`)
        .join(", ")}`,
    );
  if (models.length === 0) lines.push("  none");
  if (report.harness_reported_cost.sessions > 0) {
    const dollars = (report.harness_reported_cost.usd_micros / 1_000_000).toFixed(2);
    lines.push(
      "",
      `Claude Code's estimate: $${dollars} across ${number(report.harness_reported_cost.sessions)} sessions. Oxagen prices backfilled calls from its own price book and labels them estimated.`,
    );
  }
  const ignored = Object.entries(report.records_ignored).sort();
  if (ignored.length > 0) {
    lines.push("", "Records read and not recorded");
    for (const [type, count] of ignored) lines.push(`  ${type}: ${number(count)}`);
  }
  const unknown = Object.entries(report.drift.unknown_types).sort();
  if (unknown.length > 0 || report.drift.untested_version_sessions > 0) {
    lines.push("", "Format changes");
    for (const [type, count] of unknown)
      lines.push(`  Unknown record type ${type}: ${number(count)}`);
    if (report.drift.untested_version_sessions > 0)
      lines.push(
        `  Sessions from an untested Claude Code version: ${number(report.drift.untested_version_sessions)}`,
      );
  }
  const errors = report.errors;
  if (sum(errors) > 0) {
    lines.push("", "Read errors");
    if (errors.unparseable_lines > 0)
      lines.push(`  Lines that are not JSON: ${number(errors.unparseable_lines)}`);
    if (errors.refused_lines > 0)
      lines.push(`  Lines the recorder refused: ${number(errors.refused_lines)}`);
    if (errors.long_lines > 0)
      lines.push(`  Lines over 16 MiB: ${number(errors.long_lines)}`);
    if (errors.torn_tails > 0)
      lines.push(`  Files whose last line is not finished: ${number(errors.torn_tails)}`);
    if (errors.unreadable_files > 0)
      lines.push(`  Files that could not be read: ${number(errors.unreadable_files)}`);
  }
  lines.push(
    "",
    `Bodies: the workspace keeps ${report.bodies.mode === "content_exact" ? "content" : "digests only"}, and ${number(report.bodies.shipped)} bodies ${report.dry_run ? "would be sent" : "were queued to send"}.`,
  );
  return lines;
}
