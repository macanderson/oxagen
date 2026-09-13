import { FileClock } from "lucide-react";
import { useTranslations } from "next-intl";
import type { GapId, Milestone } from "@/data/not-backed";
import { StateFrame } from "./state-frame";

/** A read with no backing store yet: honest about when it arrives, never a zero. */
export function NotRecordedYet({
  milestone,
  gap,
}: {
  milestone: Milestone;
  gap: GapId;
}) {
  const t = useTranslations("ui.pageState.notBacked");
  return (
    <StateFrame
      testId="page-state-not_backed"
      icon={FileClock}
      title={t("title")}
      body={
        milestone === "spec-decision"
          ? t("bodySpecDecision", { gap })
          : t("body", { milestone, gap })
      }
    />
  );
}
