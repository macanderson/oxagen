// A run's state as a dot and a word in the mockup's state pill (`statusBadge`
// in engine.js draws `.b.b-<state>`), through the shared `Badge` recipe and
// never around it (ADR-132). The hue never reaches the gold.
//
// The word is the run's outcome once the run has ended, and `live` while it is
// open. `status` alone could not say it: it folds every ended run into
// `sealed` or `halted`, so a run that finished and a run that failed read the
// same. Both fields come from the same row, and `status` still drives every
// gate that asks whether the run is open.
import { useTranslations } from "next-intl";
import type { RunOutcome, RunStatus } from "@/data/contracts/runs";
import { Badge, type BadgeTone } from "./badge";

// The three readings `status` already had are unchanged: an open run is
// `allowed`, a run that finished is quiet, a cancelled run is `denied`. Only
// the two `status` could not express are new.
const TONE: Record<RunOutcome, BadgeTone> = {
  running: "allowed",
  completed: "quiet",
  failed: "failed",
  cancelled: "denied",
  crashed: "critical",
  // Not a failure and not a success: the record does not say which. It reads
  // in the same quiet pill as every other unrecorded value.
  unknown: "quiet",
};

export function StatusBadge({
  status,
  outcome,
}: {
  status: RunStatus;
  outcome: RunOutcome;
}) {
  const t = useTranslations("ui.runStatus");
  const word = status === "live" ? "live" : outcome;
  return (
    <Badge
      tone={status === "live" ? TONE.running : TONE[outcome]}
      // A run that is open is happening now, and its dot breathes to say so.
      dot={status === "live" ? "pulse" : true}
      data-status={status}
      data-outcome={outcome}
    >
      {t(word)}
    </Badge>
  );
}
