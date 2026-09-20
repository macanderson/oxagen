// A run's state as a dot and a word, so it survives greyscale; the hue sits on
// the dot only, and the word stays on the ink.
//
// The word is the run's outcome once the run has ended, and `live` while it is
// open. `status` alone could not say it: it folds every ended run into
// `sealed` or `halted`, so a run that finished and a run that failed read the
// same. Both fields come from the same row, and `status` still drives every
// gate that asks whether the run is open.
import { useTranslations } from "next-intl";
import type { RunOutcome, RunStatus } from "@/data/contracts/runs";

const DOT: Record<RunOutcome, string> = {
  running: "bg-info",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-warning",
  crashed: "bg-destructive",
  // Not a failure and not a success: the record does not say which. It reads
  // in the same ink as every other unrecorded value.
  unknown: "bg-muted-foreground",
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
    <span
      data-status={status}
      data-outcome={outcome}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${status === "live" ? DOT.running : DOT[outcome]}`}
      />
      {t(word)}
    </span>
  );
}
