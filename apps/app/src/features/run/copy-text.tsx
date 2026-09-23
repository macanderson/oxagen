"use client";
// An identifier set in mono with a button that copies it: the machine the run
// was recorded on, in the header's checkout strip. The clipboard can refuse
// (an insecure origin, a denied permission), and the refusal is said beside
// the value rather than swallowed.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { mono } from "@/ui/control-styles";

export function CopyText({ text }: { text: string }) {
  const t = useTranslations("run.header");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <code
        className={`${mono} rounded-md border border-border px-2 py-0.5 text-[11.5px]`}
      >
        {text}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t("copyLabel", { text })}
        className="rounded px-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        {state === "copied" ? t("copied") : t("copy")}
      </button>
      {state === "failed" ? (
        <span role="status" className="text-[11px] text-muted-foreground">
          {t("copyFailed")}
        </span>
      ) : null}
    </span>
  );
}
