"use client";
// A public id set small and dim in mono, with an icon button that copies it:
// the organization's `org_…` in the Workspaces header and each workspace's
// `wrk_…` under its slug. The id is a detail, never a row's label, so it sits
// below the name and the slug and ends in an ellipsis when the cell is narrow.
// The clipboard can refuse (an insecure origin, a denied permission), and the
// refusal is said beside the id rather than swallowed. The id stays
// selectable either way.
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { mono } from "@/ui/control-styles";

export function CopyId({
  value,
  label,
}: {
  /** The public id, copied exactly as shown. */
  value: string;
  /** The button's accessible name, already translated. */
  label: string;
}) {
  const t = useTranslations("organization.copyId");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  const Icon = state === "copied" ? Check : Copy;
  return (
    <span
      data-copy-id={value}
      className="inline-flex max-w-full items-center gap-0.5 text-[11px] text-dim"
    >
      <code className={`${mono} min-w-0 select-all truncate`} title={value}>
        {value}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={label}
        title={label}
        className="-my-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-dim hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Icon aria-hidden="true" className="size-3" />
      </button>
      <span role="status">
        {state === "copied"
          ? t("copied")
          : state === "failed"
            ? t("copyFailed")
            : ""}
      </span>
    </span>
  );
}
