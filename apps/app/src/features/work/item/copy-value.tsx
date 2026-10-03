"use client";
// A small copy button beside a value a person pastes elsewhere: a brief's
// digest, a work order's key. The clipboard can refuse (an insecure origin, a
// denied permission). The refusal is said beside the button rather than
// thrown, and the value stays on screen to select by hand.
import { CopyIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/ui/button";

export function CopyValue({
  value,
  label,
  testId,
}: {
  /** The exact text copied. */
  value: string;
  /** What the value is, for the button's name: "digest", "work order key". */
  label: string;
  testId?: string;
}) {
  const t = useTranslations("workItem.copy");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid={testId}
        onClick={() => {
          void copy();
        }}
        aria-label={t("label", { label })}
        className="flex-none max-md:size-11"
      >
        <CopyIcon aria-hidden="true" className="size-3.5" />
      </Button>
      <span role="status" className="text-xs text-muted-foreground">
        {state === "copied" ? t("copied") : state === "failed" ? t("failed") : ""}
      </span>
    </span>
  );
}
