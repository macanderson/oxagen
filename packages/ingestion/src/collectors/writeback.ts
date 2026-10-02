// collectors/writeback.ts: the one door to a provider write.
//
// Every provider write goes through runWriteBack, which calls the module only
// when the collector file turns that switch on and the collector is not
// paused. The switches come from the file's [write_back] table with the
// defaults filled in (file.ts). Oxagen writes only its own text: the note is a
// certify or send note Oxagen wrote, never text a requester sent.
//
// A send note can carry spend (F34): when Oxagen sends a work order back to
// its work item, the note lists the runs that ended with nothing kept and what
// each one cost. runWriteBack adds those lines to the note's text, because a
// module's note takes text only.
import type { WriteBackSwitch, WriteBackSwitches } from "./file";
import type { CollectorHealth } from "./health";
import type { AnyCollectorDefinition } from "./registry";
import type { WriteBackTarget } from "./types";

/**
 * Why a run's work did not land, as detector 8 reads its outcome:
 * - closed_unmerged: every pull request the run opened closed without merging.
 * - reverted: a pull request merged, and a later change reverted it.
 * - abandoned: the run was given up before it opened a pull request.
 */
export type WriteBackRunEnd = "closed_unmerged" | "reverted" | "abandoned";

/** What one run cost. */
export interface WriteBackAmount {
  micros: bigint;
  /** An ISO 4217 code, such as `USD`. */
  currency: string;
}

/** One run a send note lists. */
export interface WriteBackSpendRun {
  /** The run's public id: `arun_…` or `tse_…`. */
  runId: string;
  reason: WriteBackRunEnd;
  /** Null when no model call of the run was priced. The note says so, and the total leaves it out. */
  cost: WriteBackAmount | null;
}

/** The spend a send note carries: the runs that ended with nothing kept, newest first. */
export interface WriteBackSpend {
  runs: readonly WriteBackSpendRun[];
}

/** One write a work item's lifecycle asks for. */
export type WriteBackRequest =
  | { switch: "certify_note"; text: string }
  | { switch: "send_note"; text: string; spend?: WriteBackSpend }
  | { switch: "status"; status: string }
  | { switch: "close" }
  | { switch: "labels"; labels: { priority: string; type: string } };

/**
 * - written: the module made the write.
 * - off: the collector file leaves the switch off, so nothing was called.
 * - paused: a person paused the collector, which stops its writes too.
 * - unsupported: the module has no write-back, as Slack and email do not.
 */
export type WriteBackOutcome = "written" | "off" | "paused" | "unsupported";

/** The collector a write goes through. */
export interface WriteBackCollector {
  definition: AnyCollectorDefinition;
  /** From the collector file, with the defaults filled in. */
  switches: WriteBackSwitches;
  health: CollectorHealth;
}

const RUN_END_TEXT: Readonly<Record<WriteBackRunEnd, string>> = {
  closed_unmerged: "pull request closed unmerged",
  reverted: "pull request merged, then reverted",
  abandoned: "run abandoned before it opened a pull request",
};

/** An amount as the note shows it, such as `$12.34`. */
export function formatWriteBackAmount(amount: WriteBackAmount): string {
  const value = Number(amount.micros) / 1_000_000;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: amount.currency,
    }).format(value);
  } catch {
    // Intl refuses a code it does not know. Show the code as it is stored.
    return `${value.toFixed(2)} ${amount.currency}`;
  }
}

const runCount = (n: number): string => (n === 1 ? "1 run" : `${n} runs`);

/**
 * The lines a send note adds for its spend: the total, then one line per run.
 * A run with no priced cost reads "not priced" and stays out of the total.
 * Runs priced in more than one currency get one total per currency.
 */
export function renderWriteBackSpend(spend: WriteBackSpend): string {
  const count = spend.runs.length;
  const byCurrency = new Map<string, bigint>();
  let unpriced = 0;
  for (const run of spend.runs) {
    if (run.cost === null) {
      unpriced += 1;
      continue;
    }
    byCurrency.set(run.cost.currency, (byCurrency.get(run.cost.currency) ?? 0n) + run.cost.micros);
  }
  let head: string;
  if (byCurrency.size === 0) {
    head = `Unproductive spend: not priced for any of the ${runCount(count)}.`;
  } else {
    const total = [...byCurrency.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, micros]) => formatWriteBackAmount({ micros, currency }))
      .join(" and ");
    head = `Unproductive spend: ${total} across ${runCount(count)}.`;
    if (unpriced > 0)
      head += ` ${runCount(unpriced)} ${unpriced === 1 ? "is" : "are"} not priced, so the total leaves ${unpriced === 1 ? "it" : "them"} out.`;
  }
  const lines = spend.runs.map(
    (run) =>
      `- ${run.runId}: ${run.cost === null ? "not priced" : formatWriteBackAmount(run.cost)}, ${RUN_END_TEXT[run.reason]}`,
  );
  return [head, ...lines].join("\n");
}

/** The send note's text, with its spend lines after it when it carries any runs. */
function sendNoteText(request: { text: string; spend?: WriteBackSpend }): string {
  if (request.spend === undefined || request.spend.runs.length === 0) return request.text;
  return `${request.text}\n\n${renderWriteBackSpend(request.spend)}`;
}

/** Make one provider write if its switch is on. A module error propagates. */
export async function runWriteBack(
  collector: WriteBackCollector,
  target: WriteBackTarget,
  request: WriteBackRequest,
): Promise<WriteBackOutcome> {
  const name: WriteBackSwitch = request.switch;
  if (!collector.switches[name]) return "off";
  if (collector.health === "paused") return "paused";
  const writeBack = collector.definition.writeBack;
  if (!writeBack) return "unsupported";
  switch (request.switch) {
    case "certify_note":
      await writeBack.note(target, request.text);
      break;
    case "send_note":
      await writeBack.note(target, sendNoteText(request));
      break;
    case "status":
      await writeBack.status(target, request.status);
      break;
    case "close":
      await writeBack.close(target);
      break;
    case "labels":
      await writeBack.labels(target, request.labels);
      break;
  }
  return "written";
}
