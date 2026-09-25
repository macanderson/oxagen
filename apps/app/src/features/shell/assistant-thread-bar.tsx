"use client";
// The row under the flyout's header: where the thread stands, and "New thread"
// (#4163). The thread is read back from the record when the flyout opens, so
// the row says when that read is out or failed. "New thread" empties the
// thread on screen and the next question opens a new conversation; the old
// one stays on the record.
//
// The status is a polite live region that renders on every pass, with only
// its text conditional: a region inserted in the same commit as its own text
// is announced unreliably (the flyout's log follows the same rule).
import { useTranslations } from "next-intl";
import { linkText } from "@/ui/control-styles";
import type { ThreadStatus } from "./assistant-threads";

export function AssistantThreadBar({
  status,
  canStartNew,
  onNewThread,
}: {
  status: ThreadStatus;
  /** False while a turn is in flight, or when the thread is already empty. */
  canStartNew: boolean;
  onNewThread: () => void;
}) {
  const t = useTranslations("shell.assistant.thread");
  return (
    <div
      data-testid="assistant-thread-bar"
      className="flex flex-none items-center gap-3 border-b border-border px-4 py-1.5 text-[12px] text-muted-foreground"
    >
      <p
        role="status"
        data-testid="assistant-thread-status"
        className="min-w-0 flex-1"
      >
        {status === "loading"
          ? t("loading")
          : status === "failed"
            ? t("loadFailed")
            : null}
      </p>
      <button
        type="button"
        data-testid="assistant-new-thread"
        disabled={!canStartNew}
        onClick={onNewThread}
        className={`flex-none ${linkText} disabled:opacity-60`}
      >
        {t("new")}
      </button>
    </div>
  );
}
