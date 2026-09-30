// collectors/writeback.ts: the one door to a provider write.
//
// Every provider write goes through runWriteBack, which calls the module only
// when the collector file turns that switch on and the collector is not
// paused. The switches come from the file's [write_back] table with the
// defaults filled in (file.ts). Oxagen writes only its own text: the note is a
// certify or send note Oxagen wrote, never text a requester sent.
import type { WriteBackSwitch, WriteBackSwitches } from "./file";
import type { CollectorHealth } from "./health";
import type { AnyCollectorDefinition } from "./registry";
import type { WriteBackTarget } from "./types";

/** One write a work item's lifecycle asks for. */
export type WriteBackRequest =
  | { switch: "certify_note" | "send_note"; text: string }
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
    case "send_note":
      await writeBack.note(target, request.text);
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
