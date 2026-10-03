"use client";
// The header's copy buttons: the run id under the session name (#4571), and
// the checkout chip in the second strip (mockup `runWhere`, `copyPath`),
// `<machine>:<path>`. The clipboard can refuse (an insecure origin, a denied
// permission); the refusal is said beside the button rather than thrown, and
// the text stays on screen to select by hand.
import { CopyIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { linkChip } from "@/ui/control-styles";

type CopyState = "idle" | "copied" | "failed";

function useCopy(text: string): [CopyState, () => Promise<void>] {
  const [state, setState] = useState<CopyState>("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return [state, copy];
}

function CopyStatus({ state, text }: { state: CopyState; text: string }) {
  const t = useTranslations("run.header");
  return (
    <span role="status" className="text-xs text-muted-foreground">
      {state === "copied"
        ? t("copied", { text })
        : state === "failed"
          ? t("copyFailed")
          : ""}
    </span>
  );
}

/**
 * The run id on the line under the session name. It is small and mono
 * because a person reads the name, and copies the id into a CLI, a ticket,
 * or a search.
 */
export function CopyRunId({ id }: { id: string }) {
  const t = useTranslations("run.header");
  const [state, copy] = useCopy(id);
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <button
        type="button"
        data-testid="run-id"
        onClick={() => void copy()}
        aria-label={t("copyLabel", { text: id })}
        className="inline-flex min-w-0 items-center gap-1 rounded-sm font-mono text-xs text-dim hover:text-foreground max-md:min-h-11"
      >
        <span className="min-w-0 break-all">{id}</span>
        <CopyIcon aria-hidden="true" className="size-3 flex-none opacity-70" />
      </button>
      <CopyStatus state={state} text={id} />
    </span>
  );
}

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
  const [state, copy] = useCopy(text);

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
      <button
        type="button"
        data-testid="run-checkout-path"
        onClick={() => void copy()}
        title={title}
        aria-label={t("copyLabel", { text })}
        className={`${linkChip} font-mono text-xs font-medium`}
      >
        <TreeStructureIcon
          aria-hidden="true"
          className="size-3 flex-none opacity-80"
        />
        <span className="min-w-0 truncate [direction:rtl] [text-align:left]">
          <bdi>{text}</bdi>
        </span>
      </button>
      <CopyStatus state={state} text={text} />
    </span>
  );
}
