"use client";
// The record page's interactive half (mockups/pages/record.md): the header
// with its three actions, the statement editor, and the two dialogs. The
// draft lives here because the header's Discard and the editor's change state
// read the same fact. The Lineage, kind and related panels are server-rendered
// and arrive as slots, in the mockup's source order: the editor, its note and
// the Lineage panel on the left, the kind panel and related records on the
// right, one column on a phone with the editor first.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { RecordDetail } from "@/data/contracts/steering";
import { Badge } from "@/ui/badge";
import { ArchiveDialog } from "./archive-dialog";
import { RECORD_GAPS } from "./gaps";
import { Header } from "./header";
import { ProposeDialog } from "./propose-dialog";
import { StatementEditor } from "./statement-editor";
import { note } from "./styles";
import type { RecordAt } from "./view";

export function RecordWorkbench({
  at,
  detail,
  repository,
  canWrite,
  pendingBranch: initialPending,
  lineagePanel,
  kindPanel,
  related,
}: {
  at: RecordAt;
  detail: RecordDetail;
  /** The main repository, `owner/name`; null when it could not be read. */
  repository: string | null;
  /** Whether this viewer's role may revise. The handler stays the authority. */
  canWrite: boolean;
  pendingBranch: string | null;
  lineagePanel: ReactNode;
  kindPanel: ReactNode;
  related: ReactNode;
}) {
  const t = useTranslations("record.editor");
  const { record } = detail;
  const inForce = record.statement ?? "";
  const path = record.path ?? `.oxagen/rules/${at.lineage}.toml`;
  const [base, setBase] = useState(inForce);
  const [draft, setDraft] = useState(inForce);
  const [pending, setPending] = useState(initialPending);
  const [proposing, setProposing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const dirty = draft !== base;

  return (
    <div className="flex flex-col">
      <Header
        at={at}
        detail={detail}
        pendingBranch={pending}
        dirty={dirty}
        onDiscard={() => {
          setDraft(base);
        }}
        onArchive={() => {
          setArchiving(true);
        }}
        onPropose={() => {
          setProposing(true);
        }}
      />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,1fr)]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <StatementEditor
            path={t("path", { path })}
            value={draft}
            base={base}
            onChange={setDraft}
            bar={
              <span data-state="not-recorded" data-gap={RECORD_GAPS.bundle}>
                <Badge tone="quiet" dot={false}>
                  {t("tokensNotRecorded")}
                </Badge>
              </span>
            }
          />
          <p data-testid="record-editor-note" className={note}>
            {repository === null
              ? t("noteNoRepository")
              : t("note", { repository })}
          </p>
          {lineagePanel}
        </div>
        <div className="flex min-w-0 flex-col gap-3.5">
          {kindPanel}
          {related}
        </div>
      </div>
      <ProposeDialog
        open={proposing}
        onOpenChange={setProposing}
        at={at}
        path={path}
        repository={repository}
        base={base}
        draft={draft}
        constraintEffect={record.constraintEffect}
        canWrite={canWrite}
        pendingBranch={pending}
        onOpened={(branch) => {
          // The draft becomes the base the editor compares against, and the
          // header shows the open branch. What is in force does not move: the
          // h1 still reads the merged statement until the pull request merges.
          setBase(draft);
          setPending(branch);
        }}
      />
      <ArchiveDialog
        open={archiving}
        onOpenChange={setArchiving}
        lineage={at.lineage}
        path={path}
        repository={repository}
        archived={record.status !== "active"}
        pendingBranch={pending}
        constraintEffect={record.constraintEffect}
      />
    </div>
  );
}
