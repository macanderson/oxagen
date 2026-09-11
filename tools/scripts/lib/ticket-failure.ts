/**
 * Saying so when a ticket-filing side-effect fails, without failing the job it
 * rode in on (#2555, #2556).
 *
 * Two CI steps file Linear tickets as a side-effect of something else: the
 * nightly e2e job files one when the suite goes red, and the pipeline's `checks`
 * job files them for capability-parity gaps. Both carry
 * `continue-on-error: true`, and that is correct — a Linear outage must not turn
 * a green suite red, block a merge, or paper over a real failure. The job's
 * verdict belongs to the tests and the gates, never to the ticketing.
 *
 * But `continue-on-error` swallows the exit code *and* the reason. Before this,
 * a rejected Linear key made the step a yellow mark on a green job, with the
 * explanation sitting in a log nobody opens. Every red nightly from then on went
 * unticketed and nobody knew — which is #2555, and the shape epic #2556 exists
 * to hunt.
 *
 * So: still exit 0, still do not fail the job, but print a GitHub Actions
 * annotation and append to the run summary, where a reader sees it without
 * opening the step.
 *
 * ## Why this is shared rather than copied
 *
 * The nightly script grew this treatment first. The pipeline's twin never did,
 * and nothing connected them, so the same defect stayed live on the other path
 * for as long as it took somebody to look. One implementation means fixing it
 * once — and means the next side-effecting step has something to reach for.
 */

import { appendFileSync } from "node:fs";

/**
 * Whether a failure will recur on every future run, or was one bad night.
 *
 * A rejected credential is permanent: every run from now on fails identically
 * until somebody rotates the key. A timeout or a 5xx is transient. The two want
 * different loudness — "this is broken until you act" against "this missed
 * once" — and telling them apart is the point. Before, both were the same
 * unread line.
 */
export function isPermanentTicketFailure(err: unknown): boolean {
  const message = (
    err instanceof Error ? err.message : String(err)
  ).toLowerCase();
  return (
    message.includes("authentication") ||
    message.includes("not authenticated") ||
    message.includes("unauthorized") ||
    message.includes("invalid api key") ||
    message.includes("forbidden") ||
    message.includes("401") ||
    message.includes("403")
  );
}

/** What a caller is filing, so the message names the thing that did not happen. */
export interface TicketContext {
  /** Short label for the annotation title, e.g. "manifest parity tickets". */
  readonly what: string;
  /** What goes untracked while this is broken, in one clause. */
  readonly consequence: string;
  /** The issue tracking this failure mode, e.g. "#2555". */
  readonly issue: string;
}

/** The annotation and summary for one failure, without printing them. */
export function ticketFailureReport(
  context: TicketContext,
  err: unknown,
): { annotation: string; summary: string } {
  const detail = err instanceof Error ? err.message : String(err);
  const permanent = isPermanentTicketFailure(err);
  const headline = permanent
    ? `${context.what} were NOT filed, and will not be until the Linear credential is fixed.`
    : `${context.what} were not filed this run.`;
  return {
    annotation: `::error title=${context.what} not filed::${headline} ${detail}`,
    summary: [
      `### ${context.what} not filed`,
      "",
      headline,
      "",
      `Reason: \`${detail}\``,
      "",
      permanent
        ? `This is a rejected credential, not a blip — ${context.consequence} until somebody rotates the key. See ${context.issue}.`
        : `This looks like a one-off. If it repeats, ${context.consequence} — see ${context.issue}.`,
    ].join("\n"),
  };
}

/**
 * Report a ticketing failure loudly, and return so the caller can exit 0.
 *
 * Returning rather than exiting keeps the decision with the caller: whether a
 * ticketing failure should end the process is the caller's business, and this
 * function's business is only that the failure is visible.
 */
export function reportTicketFailure(
  context: TicketContext,
  err: unknown,
): void {
  const { annotation, summary } = ticketFailureReport(context, err);
  console.error(
    `[${context.what}] FAILED:`,
    err instanceof Error ? err.message : err,
  );
  console.log(annotation);
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath === undefined || summaryPath === "") return;
  try {
    appendFileSync(summaryPath, `${summary}\n`);
  } catch {
    // The annotation above already carries the message. A summary that cannot
    // be written must not become a second failure — that would be this
    // module's own bug reintroducing the thing it exists to prevent.
  }
}
