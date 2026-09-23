"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { buttonSecondary } from "@/ui/control-styles";

export function CopyLocation({ path }: { path: string }) {
  const t = useTranslations("run.workCi");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={`${buttonSecondary} min-h-11 px-3 text-xs`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(path);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {t("copyLocation")}
      </button>
      <span role="status" className="text-xs">
        {state === "copied"
          ? t("copied")
          : state === "failed"
            ? t("copyFailed")
            : ""}
      </span>
    </span>
  );
}
