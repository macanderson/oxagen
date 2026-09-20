"use client";
// The Working copies tab (mockup `copyTab()`, `DLG_EXT.linkdir`): the same
// `.oxagen/` tree on a machine. No store records a working copy yet: `oxagen
// init` writes `.oxagen/workspace.json` on the machine and reports nothing
// back, so the tab says that instead of drawing a table it would have to
// invent. What it can say truthfully it says in full: which of the two files
// is reviewed, how the CLI syncs a directory today, and why a stale copy is
// not a stale run.
import { useTranslations } from "next-intl";
import { mono } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";
import { WORKSPACE_JSON, WORKSPACE_TOML } from "./draft";
import { Explainer, prose } from "./parts";

/** The CLI commands the tab names. Commands, not prose, so they stay out of the catalogue. */
const CLI = {
  init: "oxagen init",
  status: "oxagen steering status",
  propose: "oxagen context propose",
  pull: "oxagen pull",
} as const;

export function WorkingCopies() {
  const t = useTranslations("repositories.workingCopies");
  return (
    <div data-testid="working-copies" className="flex flex-col gap-4">
      <p
        role="note"
        data-testid="working-copies-behind-note"
        className="rounded-md border border-border bg-muted/40 p-3 text-sm leading-relaxed text-foreground"
      >
        {t("behindNote")}
      </p>
      <p data-testid="working-copies-not-recorded" className={prose}>
        {t("notRecorded")}
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Explainer
          title={t("twoFiles.title")}
          testId="working-copies-two-files"
        >
          <p>
            <code className={mono}>{WORKSPACE_TOML}</code> {t("twoFiles.toml")}
          </p>
          <p>
            <code className={mono}>{WORKSPACE_JSON}</code> {t("twoFiles.json")}
          </p>
          <p>{t("twoFiles.gitignore")}</p>
        </Explainer>
        <Explainer title={t("sync.title")} testId="working-copies-sync">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2">
            <dt className={mono}>{CLI.init}</dt>
            <dd>{t("sync.init")}</dd>
            <dt className={mono}>{CLI.status}</dt>
            <dd>{t("sync.status")}</dd>
            <dt className={mono}>{CLI.propose}</dt>
            <dd>{t("sync.propose")}</dd>
            <dt className={mono}>{CLI.pull}</dt>
            <dd>{t("sync.pull")}</dd>
          </dl>
          <p>{t("sync.merge")}</p>
        </Explainer>
      </div>
    </div>
  );
}

/**
 * The pairing dialog (mockup `DLG_EXT.linkdir`). There is no browse button:
 * the browser cannot see a filesystem, and a path typed into a web form
 * proves nothing about what is at it. The directory identifies itself by
 * running one command in it.
 */
export function ConnectDirectoryDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("repositories.workingCopies.connect");
  return (
    <SheetDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title={t("title")}
      testId="connect-directory-dialog"
    >
      <div className={`flex flex-col gap-3 ${prose}`}>
        <p>{t("about")}</p>
        <pre className="rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground">
          {CLI.init}
        </pre>
        <p>{t("reads")}</p>
        <p data-testid="connect-directory-pairing">{t("pairing")}</p>
        <p>{t("grantsNothing")}</p>
      </div>
    </SheetDialog>
  );
}
