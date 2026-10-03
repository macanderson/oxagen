"use client";
// Archive a record (mockup `DLG_EXT.crecarchive`). Archiving is a pull
// request that sets `status = "archived"` on the record's file: the file
// stays, the lineage stays, and the record stops compiling into the bundle
// when it merges. Nothing is deleted.
//
// No capability opens that pull request yet (#3867), so the dialog says what
// the product would do and draws Open the pull request disabled with the
// reason beside it. A record with a pull request already open, or one already
// archived, says so instead, so two changes are never proposed over one file.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { ConstraintEffect } from "@/data/contracts/steering";
import { mono } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";
import { RECORD_GAPS } from "./gaps";
import { buttonDanger } from "./header";
import { note } from "./styles";

const code = (chunks: ReactNode) => <span className={mono}>{chunks}</span>;
const warnClass =
  "rounded-lg border border-warning/45 bg-warning/9 px-3 py-2 text-[12.5px] leading-relaxed text-foreground";

export function ArchiveDialog({
  open,
  onOpenChange,
  lineage,
  path,
  repository,
  archived,
  pendingBranch,
  constraintEffect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lineage: string;
  path: string;
  repository: string | null;
  archived: boolean;
  pendingBranch: string | null;
  constraintEffect: ConstraintEffect | null;
}) {
  const t = useTranslations("record.archive");
  if (archived || pendingBranch !== null) {
    return (
      <SheetDialog
        open={open}
        onOpenChange={onOpenChange}
        title={
          archived
            ? t("archivedTitle", { lineage })
            : t("pendingTitle", { lineage })
        }
        testId="record-archive"
      >
        <p className={note}>
          {archived
            ? t("archivedBody")
            : t.rich("pendingBody", { branch: pendingBranch ?? "", code })}
        </p>
      </SheetDialog>
    );
  }
  return (
    <SheetDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title", { lineage })}
      testId="record-archive"
      closeLabel={t("keep")}
      footer={
        <button
          type="button"
          data-testid="record-archive-submit"
          disabled
          aria-describedby="record-archive-gap"
          data-gap={RECORD_GAPS.archive}
          className={`${buttonDanger} max-md:w-full`}
        >
          {t("submit")}
        </button>
      }
    >
      <div className="flex flex-col gap-2.5">
        <p className={note}>{t.rich("body", { path, code })}</p>
        {constraintEffect === null ? null : (
          <p data-testid="record-archive-gate" className={warnClass}>
            {t.rich("gate", { effect: constraintEffect, code })}
          </p>
        )}
        <p className={note}>{t("kept")}</p>
        <p
          id="record-archive-gap"
          data-state="not-recorded"
          className="text-xs text-dim"
        >
          {repository === null
            ? t("notRecordedNoRepo")
            : t.rich("notRecorded", { repository, code })}
        </p>
      </div>
    </SheetDialog>
  );
}
