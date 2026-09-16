// A run's status as a dot and a word, so it survives greyscale; the hue sits on
// the dot only, and the word stays on the ink.
import { useTranslations } from "next-intl";
import type { RunStatus } from "@/data/contracts/runs";

const DOT: Record<RunStatus, string> = {
  live: "bg-info",
  sealed: "bg-muted-foreground",
  halted: "bg-warning",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const t = useTranslations("ui.runStatus");
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${DOT[status]}`}
      />
      {t(status)}
    </span>
  );
}
