"use client";
// Propose a change to this record (mockup `DLG_EXT.srcpr`, `crecSave`). A
// published record is changed the way it was published: a branch, a pull
// request, the same six checks, and a merge. Nothing here edits what is in
// force.
//
// The write is `revise_context_record`: it raises a proposal carrying the
// record's kind, force, effect and scope exactly as they stand, then hands it
// to `open_context_pr`, which commits the file to `context/<lineage>`, opens
// the pull request and runs the six checks. The handler gates the role
// (INV-29), so a role that may not revise is refused there whatever this
// dialog draws.
import { useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import type { ConstraintEffect } from "@/data/contracts/steering";
import { diffLines, diffStat } from "@/shared/line-diff";
import { Badge } from "@/ui/badge";
import { buttonPrimary, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { SheetDialog } from "@/ui/sheet-dialog";
import { reviseRecord } from "./actions";
import { UNANSWERED, useReviseFailure } from "./revise-failure";
import type { RecordAt } from "./view";

/** The six publication checks, re-run for an amendment, in the order they run. */
const CHECKS = [
  "schema",
  "lineage",
  "hash",
  "secret",
  "conflict",
  "effect",
] as const;

type Opened = Extract<
  Awaited<ReturnType<typeof reviseRecord>>,
  { ok: true }
>["value"];

const code = (chunks: ReactNode) => <span className={mono}>{chunks}</span>;

/** `wzChecks`: one row per check, the name then what it asserts. */
export function CheckRows({
  rows,
}: {
  rows: readonly { key: string; name: string; what: ReactNode }[];
}) {
  return (
    <ul className="grid gap-2 text-[13px]">
      {rows.map((row) => (
        <li
          key={row.key}
          data-check={row.key}
          className="grid gap-x-3 gap-y-0.5 rounded-md border border-border px-3 py-2 sm:grid-cols-[180px_minmax(0,1fr)]"
        >
          <b className="font-semibold text-foreground">{row.name}</b>
          <span className="text-muted-foreground">{row.what}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProposeDialog({
  open,
  onOpenChange,
  at,
  path,
  repository,
  base,
  draft,
  constraintEffect,
  canWrite,
  pendingBranch,
  onOpened,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  at: RecordAt;
  /** `.oxagen/rules/<lineage>.toml`. */
  path: string;
  /** The main repository the pull request opens on; null when unread. */
  repository: string | null;
  base: string;
  draft: string;
  constraintEffect: ConstraintEffect | null;
  canWrite: boolean;
  pendingBranch: string | null;
  /** The pull request opened on `branch`; the page records it as pending. */
  onOpened: (branch: string) => void;
}) {
  const t = useTranslations("record.propose");
  const failureText = useReviseFailure();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const branch = `context/${at.lineage}`;
  const rows = useMemo(() => diffLines(base, draft), [base, draft]);
  const stat = useMemo(() => diffStat(base, draft), [base, draft]);
  const changed = draft !== base;
  const blocked = !canWrite || pendingBranch !== null;

  function openChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setFailure(null);
      setOpened(null);
    }
  }

  async function submit() {
    if (pending || !changed || blocked) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await reviseRecord(at.org, at.ws, at.lineage, draft, "");
      if (result.ok) {
        setOpened(result.value);
        onOpened(branch);
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  const checks = CHECKS.map((key) => ({
    key,
    name: t(`checks.${key}.name`),
    what: t.rich(`checks.${key}.what`, {
      lineage: at.lineage,
      effect: constraintEffect ?? t("checks.effect.absent"),
      code,
    }),
  }));

  return (
    <SheetDialog
      open={open}
      onOpenChange={openChange}
      title={t("title")}
      subtitle={path}
      wide
      testId="record-propose"
      closeLabel={opened === null ? t("cancel") : undefined}
      footer={
        opened === null ? (
          <button
            type="button"
            data-testid="record-propose-submit"
            disabled={!changed || blocked || pending}
            onClick={() => {
              void submit();
            }}
            className={`${buttonPrimary} max-md:w-full`}
          >
            {pending ? t("pending") : t("submit")}
          </button>
        ) : null
      }
    >
      {opened === null ? (
        <div className="flex flex-col gap-3.5">
          <p className="text-[13px] text-foreground">{t("lead")}</p>
          {failure === null ? null : (
            <FormAlert testId="record-propose-failure">{failure}</FormAlert>
          )}
          {pendingBranch === null ? null : (
            <p
              data-testid="record-propose-pending"
              className="border-l-2 border-info pl-3 text-[12.5px] text-muted-foreground"
            >
              {t.rich("pendingOpen", { branch: pendingBranch, code })}
            </p>
          )}
          {canWrite ? null : (
            <p
              data-testid="record-propose-read-only"
              className="border-l-2 border-warning pl-3 text-[12.5px] text-muted-foreground"
            >
              {t("readOnly")}
            </p>
          )}
          <div
            data-testid="record-diff"
            className="overflow-hidden rounded-[10px] border border-border"
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
              {repository === null ? null : (
                <Badge tone="quiet" dot={false} mono>
                  {repository}
                </Badge>
              )}
              <span aria-hidden="true" className="text-dim">
                ←
              </span>
              <Badge tone="approval" dot={false} mono>
                {branch}
              </Badge>
              <span className="flex-1" />
              <span
                data-testid="record-diff-stat"
                aria-label={t("statLabel", stat)}
                className="font-mono"
              >
                <span className="text-success">{`+${String(stat.added)}`}</span>{" "}
                <span className="text-error-ink">{`−${String(stat.removed)}`}</span>
              </span>
            </div>
            {changed ? (
              <div className="max-h-64 overflow-auto bg-code-bg font-mono text-xs">
                {rows.map((row, index) => (
                  <div
                    key={`${String(index)}-${row.op}`}
                    data-side={row.op}
                    className={`grid grid-cols-[2.5rem_2.5rem_1rem_minmax(0,1fr)] gap-1 px-2 py-0.5 ${
                      row.op === "add"
                        ? "bg-success/10"
                        : row.op === "del"
                          ? "bg-error/10"
                          : ""
                    }`}
                  >
                    <span className="text-right text-dim">
                      {row.before ?? ""}
                    </span>
                    <span className="text-right text-dim">
                      {row.after ?? ""}
                    </span>
                    <span aria-hidden="true">
                      {row.op === "add" ? "+" : row.op === "del" ? "−" : " "}
                    </span>
                    <span className="whitespace-pre-wrap break-words text-foreground">
                      {row.text}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-4 py-3.5 text-[13px] text-dim">
                {t("nothingChanged")}
              </p>
            )}
          </div>
          <section
            aria-labelledby="record-propose-checks"
            className="flex flex-col gap-2"
          >
            <h3
              id="record-propose-checks"
              className="text-[12px] font-semibold text-muted-foreground"
            >
              {t("checksLabel")}
            </h3>
            <CheckRows rows={checks} />
          </section>
        </div>
      ) : (
        <div
          role="status"
          data-testid="record-propose-done"
          className="flex flex-col gap-2 text-[13px]"
        >
          <p className="text-foreground">
            {opened.prNumber === null
              ? t("doneNoPr", { lineage: at.lineage })
              : t("done", {
                  repository: repository ?? "",
                  number: opened.prNumber,
                  lineage: at.lineage,
                })}
          </p>
          <p className="text-muted-foreground">
            {t(`status.${opened.status}`)}
          </p>
        </div>
      )}
    </SheetDialog>
  );
}
