"use client";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { openApprovals } from "@/shared/approvals-drawer";

export function ApprovalsEntry({ children }: { children?: ReactNode }) {
  const t = useTranslations("fleet.stats.waiting");
  return (
    <button
      type="button"
      onClick={openApprovals}
      aria-label={t("open")}
      className="min-h-11 min-w-11 rounded text-left underline decoration-border underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-ring"
    >
      {children ?? t("open")}
    </button>
  );
}
