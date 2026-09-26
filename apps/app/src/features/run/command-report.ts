// The delivery report's shared readings (#2953), used by the report dialog
// and by a command frame's inspector: the hue each §7.4 status takes, how the
// report counts it, the key each delivery mode's label sits under, and which
// row of the report a command frame records.
//
// A plain module, not a client one, so a server component that renders the
// inspector reads these values rather than client references.
import type { CommandReport, DeliveryMode } from "@/data/contracts/runs";
import type { BadgeTone } from "@/ui/badge";

export type ReportCommand = CommandReport["commands"][number];
type Status = ReportCommand["status"];

/** A status's hue: applied is the success hue, the undelivered ones warn, the rest wait. */
export const STATUS_TONE: Record<Status, BadgeTone> = {
  draft: "quiet",
  queued: "approval",
  sent: "approval",
  received: "approval",
  acknowledged: "approval",
  applied: "allowed",
  cancelled: "denied",
  expired: "denied",
  failed: "failed",
};

/** How the report counts a status: applied, still on its way, or undelivered. */
export type Tally = "applied" | "pending" | "undelivered";
export const STATUS_TALLY: Record<Status, Tally> = {
  draft: "pending",
  queued: "pending",
  sent: "pending",
  received: "pending",
  acknowledged: "pending",
  applied: "applied",
  cancelled: "undelivered",
  expired: "undelivered",
  failed: "undelivered",
};
export const TALLIES: readonly Tally[] = ["applied", "pending", "undelivered"];

/** The key each delivery mode's label sits under in `run.commands.delivery`. */
export const DELIVERY_COPY = {
  next_step: "nextStep",
  interrupt: "interrupt",
  turn_boundary: "turnBoundary",
} as const satisfies Record<DeliveryMode, string>;

/** The reasons a mode was carried below the one asked for (`degraded_reason`). */
const DEGRADED_REASONS = ["harness_tier", "no_step_carrier"] as const;
type DegradedReason = (typeof DEGRADED_REASONS)[number];

/** A recorded reason the report has words for, or null for one it shows as recorded. */
export function degradedOf(reason: string): DegradedReason | null {
  return (DEGRADED_REASONS as readonly string[]).includes(reason)
    ? (reason as DegradedReason)
    : null;
}

/**
 * The report's row for the command applied at `seq`, or undefined when no
 * row names it. The host's acknowledgement names the frame it sealed as
 * `applied_at_seq`, so a command frame and its row share that seq.
 */
export function commandAt(
  report: CommandReport,
  command: string,
  seq: string,
): ReportCommand | undefined {
  return report.commands.find(
    (row) =>
      row.command === command &&
      row.appliedAtSeq !== null &&
      String(row.appliedAtSeq) === seq,
  );
}
