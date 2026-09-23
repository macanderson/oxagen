"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { buttonSecondary } from "@/ui/control-styles";

export function CopyLocation({ path }: { path: string }) {
  const t = useTranslations("run.work");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(path);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={`${buttonSecondary} min-h-11 px-3 text-xs`}
        onClick={() => void copy()}
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
