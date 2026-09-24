"use client";
// The Working copies tab (mockup `copyTab()`; MC spec §10.1): the same
// `.oxagen/` tree on a machine, and how a directory is linked to it.
//
// No store records a working copy: `oxagen init` writes
// `.oxagen/workspace.json` on the machine and reports nothing back (#3241).
// So the table draws its columns and one not-recorded row, never an empty
// table that would read as "nobody has a copy". Connect a directory still
// works, because the command it gives is the CLI's own and links the
// directory on the machine; what it cannot do yet is make that copy appear
// here, and the dialog says so.
//
// A working copy's state is never a run's state: steering reaches a run from
// the merged commit, so a stale laptop only costs the person looking at it.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";
import { cell, headCell } from "@/ui/table";
import { REPOSITORY_GAPS } from "./gaps";
import { WORKSPACE_JSON, WORKSPACE_TOML } from "./draft";
import { CheckRows, code, note, Panel, PanelBody } from "./parts";

const COPY_COLUMNS = [
  "directory",
  "repository",
  "branch",
  "oxagen",
  "symlinks",
  "bundle",
  "lastSeen",
] as const;

const SYNC = ["init", "pull", "status", "propose"] as const;

export function WorkingCopies({
  primary,
  onConnect,
}: {
  /** Connect a directory holds the screen's one gold while this tab shows. */
  primary: boolean;
  onConnect: () => void;
}) {
  const t = useTranslations("repositories.copies");
  const columns = useTranslations("repositories.copies.columns");
  return (
    <div data-testid="working-copies" className="flex flex-col gap-3.5">
      <Panel
        id="working-copies-panel"
        testId="working-copies-panel"
        title={t("title")}
        subtitle={t.rich("subtitle", { code })}
        action={
          <button
            type="button"
            data-testid="working-copies-connect"
            data-touch-target=""
            aria-haspopup="dialog"
            className={primary ? buttonPrimary : buttonSecondary}
            onClick={onConnect}
          >
            {t("connect")}
          </button>
        }
      >
        <div className="min-w-0 overflow-x-auto">
          <table
            aria-label={t("label")}
            data-testid="working-copies-table"
            className="w-full min-w-[720px] border-collapse text-[13px]"
          >
            <thead>
              <tr className="border-b border-border">
                {COPY_COLUMNS.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className={`${headCell} text-left`}
                  >
                    {columns(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td
                  colSpan={COPY_COLUMNS.length}
                  data-testid="working-copies-not-recorded"
                  data-state="not-recorded"
                  data-gap={REPOSITORY_GAPS.lifecycle}
                  className={`${cell} text-[13px] leading-relaxed text-muted-foreground`}
                >
                  {t.rich("notRecorded", { code })}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-4 py-3.5">
          <p className={note}>{t("stale")}</p>
        </div>
      </Panel>
      <div className="grid gap-3.5 md:grid-cols-2">
        <Panel
          id="working-copies-files"
          testId="working-copies-files"
          title={t("filesTitle")}
        >
          <PanelBody>
            <pre className="overflow-x-auto rounded-[10px] border border-border bg-code-bg px-3.5 py-3 font-mono text-[12px] leading-[1.6] text-foreground">
              {".oxagen/\n"}
              {`  ${WORKSPACE_TOML.replace(".oxagen/", "").padEnd(18)}`}
              <span className="text-code-comment">{t("filesToml")}</span>
              {"\n"}
              {`  ${WORKSPACE_JSON.replace(".oxagen/", "").padEnd(18)}`}
              <span className="text-code-comment">{t("filesJson")}</span>
              {"\n  rules/\n  proposals/\n  agents/\n  skills/\n  tools/"}
            </pre>
            <p className={`mt-3 ${note}`}>{t("filesNote")}</p>
          </PanelBody>
        </Panel>
        <Panel
          id="working-copies-sync"
          testId="working-copies-sync"
          title={t("syncTitle")}
        >
          <PanelBody>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-[13px] leading-relaxed max-sm:grid-cols-1">
              {SYNC.map((command) => (
                <div key={command} className="contents" data-command={command}>
                  <dt className={`${mono} text-dim`}>{`oxagen ${command}`}</dt>
                  <dd className="text-foreground">
                    {t.rich(`sync.${command}`, { code })}
                  </dd>
                </div>
              ))}
            </dl>
            <p className={`mt-3 ${note}`}>{t.rich("syncNote", { code })}</p>
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}

/**
 * Connect a directory (mockup `DLG_EXT.linkdir`): the one command, what it
 * writes and links, what it does not write or read, and that linking grants
 * nothing. The pairing code the design shows is not issued by anything yet
 * (#3241), so the command carries the CLI's own flags and a comment that says
 * the code is missing.
 */
export function ConnectDirectoryDialog({
  org,
  ws,
  open,
  onClose,
}: {
  org: string;
  ws: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("repositories.linkdir");
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const command = `oxagen init --org ${org} --workspace ${ws}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCopied("idle");
          onClose();
        }
      }}
      title={t("title")}
      subtitle={t("subtitle")}
      testId="linkdir-dialog"
      footer={
        <button
          type="button"
          data-testid="linkdir-copy"
          data-touch-target=""
          className={buttonPrimary}
          onClick={() => {
            void copy();
          }}
        >
          {copied === "copied" ? t("copied") : t("copy")}
        </button>
      }
    >
      <div className="flex flex-col gap-3.5">
        <p className="text-sm leading-relaxed text-foreground">{t("lead")}</p>
        <section aria-labelledby="linkdir-command">
          <h3
            id="linkdir-command"
            className="mb-1.5 text-[12.5px] font-semibold text-muted-foreground"
          >
            {t("commandLabel")}
          </h3>
          <pre
            data-testid="linkdir-command"
            className="overflow-x-auto rounded-[10px] border border-border bg-code-bg px-3.5 py-3 font-mono text-[12px] leading-[1.6] text-foreground"
          >
            {command}
            {"\n\n"}
            <span
              className="text-code-comment"
              data-state="not-recorded"
              data-gap={REPOSITORY_GAPS.lifecycle}
            >
              {t("pairing")}
            </span>
          </pre>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("pairingHint")}
          </p>
          {copied === "failed" ? (
            <p role="alert" className="mt-1.5 text-xs text-error-ink">
              {t("copyFailed")}
            </p>
          ) : null}
        </section>
        <section aria-labelledby="linkdir-what">
          <h3
            id="linkdir-what"
            className="mb-1.5 text-[12.5px] font-semibold text-muted-foreground"
          >
            {t("whatLabel")}
          </h3>
          <CheckRows
            testId="linkdir-writes"
            rows={(["writes", "links", "noWrite", "noRead"] as const).map(
              (key) => ({
                key,
                name: t(`writes.${key}.name`),
                what: t.rich(`writes.${key}.what`, { code }),
              }),
            )}
          />
        </section>
        <p className={note}>{t("grants")}</p>
      </div>
    </SheetDialog>
  );
}
