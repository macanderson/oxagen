import { FileClock } from "lucide-react";
import { useTranslations } from "next-intl";
import { type GapId, type Milestone, NO_GAP } from "@/data/not-backed";
import { StateFrame } from "./state-frame";

/**
 * A read with no backing store yet: honest about when it arrives, never a zero.
 * `G0` is "no numbered gap", so it is never shown as "gap G0": the body names
 * the milestone alone, and `M0` (the store exists, the adapter is not wired)
 * says exactly that.
 */
export function NotRecordedYet({
  milestone,
  gap,
}: {
  milestone: Milestone;
  gap: GapId;
}) {
  const t = useTranslations("ui.pageState.notBacked");
  const hasGap = gap !== NO_GAP;
  const body =
    milestone === "M0"
      ? t("bodyNotWired")
      : milestone === "spec-decision"
        ? hasGap
          ? t("bodySpecDecision", { gap })
          : t("bodySpecDecisionOnly")
        : hasGap
          ? t("body", { milestone, gap })
          : t("bodyMilestoneOnly", { milestone });
  return (
    <StateFrame
      testId="page-state-not_backed"
      icon={FileClock}
      title={t("title")}
      body={body}
    />
  );
}
