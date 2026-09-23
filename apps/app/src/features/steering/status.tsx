// A proposal's place in the Context PR state machine as a dot and a word in
// the mockup's state pill, so the state survives greyscale; the value is
// carried as `data-status`. Open states take the approval hue (a person or a
// check still stands in the way), a merge the allowed hue, a failed check the
// failed hue, and a closed proposal is quiet.
import { useTranslations } from "next-intl";
import type { ProposalStatus } from "@/data/contracts/steering";
import { Badge, type BadgeTone } from "@/ui/badge";

const TONE: Record<ProposalStatus, BadgeTone> = {
  proposed: "approval",
  pr_open: "approval",
  checks_running: "approval",
  checks_passed: "proven",
  checks_failed: "failed",
  merged: "allowed",
  rejected: "denied",
};

export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  const t = useTranslations("steering.status");
  return (
    <Badge tone={TONE[status]} data-status={status}>
      {t(status)}
    </Badge>
  );
}
