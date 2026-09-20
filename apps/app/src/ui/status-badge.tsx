// A run's status as a dot and a word in the mockup's state pill (`statusBadge`
// in engine.js draws `.b.b-<state>`): live is the allowed hue, halted the
// denied hue, and a sealed run is quiet. The hue never reaches the gold.
import { useTranslations } from "next-intl";
import type { RunStatus } from "@/data/contracts/runs";
import { Badge, type BadgeTone } from "./badge";

const TONE: Record<RunStatus, BadgeTone> = {
  live: "allowed",
  sealed: "quiet",
  halted: "denied",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  const t = useTranslations("ui.runStatus");
  return (
    <Badge tone={TONE[status]} data-status={status}>
      {t(status)}
    </Badge>
  );
}
