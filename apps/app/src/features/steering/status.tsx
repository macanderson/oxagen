// A proposal's place in the Context PR state machine as a dot and a word, so
// the state survives greyscale; the value is carried as `data-status`.
import { useTranslations } from "next-intl";
import type { ProposalStatus } from "@/data/contracts/steering";

export function StatusBadge({ status }: { status: ProposalStatus }) {
  const t = useTranslations("steering.status");
  return (
    <span
      data-status={status}
      className="inline-flex items-center gap-1.5 rounded-sm border border-border px-1.5 py-0.5 text-xs text-foreground"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {t(status)}
    </span>
  );
}
