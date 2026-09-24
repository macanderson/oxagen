"use client";
// A public id set small and dim in mono, with an icon button that copies it:
// the organization's `org_…` in the Workspaces header and each workspace's
// `wrk_…` under its slug. The id is a detail, never a row's label, so it sits
// below the name and the slug and ends in an ellipsis when the cell is narrow.
// The clipboard can refuse (an insecure origin, a denied permission), and the
// refusal is said beside the id rather than swallowed. The id stays
// selectable either way.
//
// The status speaks for the latest click only. "Copied" clears after
// COPIED_MS, so after copying the org id and then a workspace id the page
// does not claim both are on the clipboard. Each click clears the status
// first, so a repeat copy is announced again, and a click that settles after
// a later one has started leaves the status alone. A refusal stays until the
// next click, because it tells you what to do instead.
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { mono } from "@/ui/control-styles";

/** @internal How long "Copied" stays beside an id, in milliseconds; the test advances its timers by it. */
export const COPIED_MS = 3000;

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
  const latestRef = useRef(0);
  const clearRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(clearRef.current);
    },
    [],
  );

  async function copy() {
    const attempt = ++latestRef.current;
    clearTimeout(clearRef.current);
    setState("idle");
    let outcome: "copied" | "failed";
    try {
      await navigator.clipboard.writeText(value);
      outcome = "copied";
    } catch {
      outcome = "failed";
    }
    if (attempt !== latestRef.current) return;
    setState(outcome);
    if (outcome === "copied") {
      clearRef.current = setTimeout(() => {
        setState("idle");
      }, COPIED_MS);
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
