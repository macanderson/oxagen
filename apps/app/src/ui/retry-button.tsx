"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/** Re-renders the route's Server Components, or calls the error boundary's own retry. */
export function RetryButton({ onRetry }: { onRetry?: () => void }) {
  const t = useTranslations("ui.pageState.error");
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        if (onRetry) onRetry();
        else router.refresh();
      }}
      className="inline-flex h-8 items-center gap-2 rounded-md border border-button-primary-border bg-button-primary-bg px-4 text-sm font-medium text-button-primary-fg hover:bg-button-primary-hover-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-button-primary-ring"
    >
      <RotateCcw aria-hidden focusable={false} className="size-4" />
      {t("retry")}
    </button>
  );
}
