"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { RunDiff as Diff } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { readRunDiff } from "./search-actions";

/** Explicitly scoped snapshot: a worktree patch can include edits predating the run. */
export function RunDiff({
  org,
  ws,
  runId,
}: {
  org: string;
  ws: string;
  runId: string;
}) {
  const t = useTranslations("run.diff");
  const [answer, setAnswer] = useState<Read<Diff | null> | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  async function load() {
    if (loading) return;
    setLoading(true);
    setOpen(true);
    try {
      setAnswer(await readRunDiff(org, ws, runId));
    } catch {
      setAnswer({
        ok: false,
        reason: "error",
        code: "run_diff_unavailable",
        status: 503,
      });
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        className={`${buttonSecondary} self-start`}
        onClick={() => {
          if (open) setOpen(false);
          else if (answer?.ok) setOpen(true);
          else void load();
        }}
      >
        {t("title")}
      </button>
      {open ? (
        <>
          <p className="text-xs text-muted-foreground">{t("scope")}</p>
          {loading ? (
            <p role="status" className="text-sm">
              {t("loading")}
            </p>
          ) : answer && !answer.ok ? (
            <>
              <FormAlert>
                {answer.reason === "denied"
                  ? t("denied")
                  : answer.reason === "pending_approval"
                    ? t("approval", { request: answer.accessRequestId })
                    : t("error")}
              </FormAlert>
              {answer.reason === "error" ? (
                <button
                  type="button"
                  className={buttonSecondary}
                  onClick={() => void load()}
                >
                  {t("retry")}
                </button>
              ) : null}
            </>
          ) : answer?.ok ? (
            <>
              {answer.value?.baseSha ? (
                <p className="break-all text-xs text-muted-foreground">
                  {t("baseCommit", { commit: answer.value.baseSha })}
                </p>
              ) : null}
              {answer.value?.complete === false ? (
                <p className="text-sm">{t("incomplete")}</p>
              ) : answer.value?.patch == null ? (
                <p className="text-sm">{t("missing")}</p>
              ) : answer.value.patch === "" ? (
                <p className="text-sm">{t("empty")}</p>
              ) : (
                <pre
                  className={`${mono} max-h-96 overflow-auto rounded-md border border-border bg-muted p-3 text-xs`}
                >
                  <code>{answer.value.patch}</code>
                </pre>
              )}
              {answer.value?.truncated ? (
                <p className="text-xs text-muted-foreground">
                  {t("truncated")}
                </p>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
