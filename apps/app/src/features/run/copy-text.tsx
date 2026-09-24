"use client";
// The checkout chip in the header's second strip (mockup `runWhere`, `copyPath`):
// `<machine>:<path>` as a copy button. The clipboard can refuse (an insecure
// origin, a denied permission); the refusal is said beside the chip rather
// than thrown, and the path stays on screen to select by hand.
import { FolderTree } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { linkChip } from "@/ui/control-styles";

export function CopyPath({
  text,
  title,
}: {
  /** `<machine>:<path>`, exactly as it is copied. */
  text: string;
  /** Where the path came from: recorded on the host, or worked out. */
  title: string;
}) {
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
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <button
        type="button"
        data-testid="run-checkout-path"
        onClick={() => void copy()}
        title={title}
        aria-label={t("copyLabel", { text })}
        className={`${linkChip} font-mono text-[10.5px] font-medium`}
      >
        <FolderTree
          aria-hidden="true"
          className="size-3 flex-none opacity-80"
        />
        <span className="min-w-0 truncate [direction:rtl] [text-align:left]">
          <bdi>{text}</bdi>
        </span>
      </button>
      <span role="status" className="text-[11px] text-muted-foreground">
        {state === "copied"
          ? t("copied", { text })
          : state === "failed"
            ? t("copyFailed")
            : ""}
      </span>
    </span>
  );
}
