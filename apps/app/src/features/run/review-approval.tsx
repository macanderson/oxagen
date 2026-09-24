"use client";
// Review the approval, on the Outputs spine's gate node (spec pages/run.md,
// Outputs). The record gives a gate no frame, so there is no frame to open.
// The button opens the shell's approvals drawer instead, where the parked
// call is decided with its full card. The drawer is the one place a parked
// call is answered (spec: no approvals panel on Governed actions).
import { useTranslations } from "next-intl";
import { openApprovals } from "@/features/shell/client";

export function ReviewApproval({ className }: { className: string }) {
  const t = useTranslations("run.outputs");
  return (
    <button
      type="button"
      data-testid="outputs-review-approval"
      onClick={openApprovals}
      className={className}
    >
      {t("reviewApproval")}
    </button>
  );
}
