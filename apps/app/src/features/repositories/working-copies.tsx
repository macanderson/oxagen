"use client";
// The Working copies tab (mockup `copyTab()`; MC spec §10.1): the same
// `.oxagen/` tree on a machine, and how a directory is linked to it.
//
// Each row is what the CLI last reported for one directory
// (`list_working_copies`): `oxagen init` reports it when it links the
// directory, and `oxagen pull` reports it again with the commit it wrote.
// Oxagen reads nothing from the machine itself, so every cell is as of the
// row's last-seen time and the column says when that was.
//
// States: the read in flight draws skeleton bars; a refusal says which roles
// may read the list; any other failure prints its sentence with a retry; a
// workspace no directory has reported to yet says what to run; and a list at
// the read's ceiling says older rows are not listed.
//
// A working copy's state is never a run's state: steering reaches a run from
// the merged commit, so a stale laptop only costs the person looking at it.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { WorkingCopies, WorkingCopy } from "@/data/contracts/repository";
import { Badge } from "@/ui/badge";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useFormatter } from "@/ui/formatter";
import { SheetDialog } from "@/ui/sheet-dialog";
import { cell, headCell } from "@/ui/table";
import { WORKSPACE_JSON, WORKSPACE_TOML } from "./draft";
import { useRepositoriesFailure } from "./failure";
import {
  buttonSmall,
  CheckRows,
  code,
  type Load,
  note,
  Panel,
  PanelBody,
} from "./parts";
import { WORKING_COPY_LIMIT } from "./view";

const COPY_COLUMNS = [
  "directory",
  "repository",
  "branch",
  "oxagen",
  "symlinks",
  "pulled",
  "lastSeen",
] as const;

/** The CLI's sync commands, each with the message key that says what it does. */
const SYNC = [
  { key: "init", command: "oxagen init" },
  { key: "pull", command: "oxagen pull" },
  { key: "steeringStatus", command: "oxagen steering status" },
  { key: "contextPropose", command: "oxagen context propose" },
] as const;

/** A commit as the table prints it: the first seven characters. */
function short(commit: string): string {
  return commit.slice(0, 7);
}

export function WorkingCopies({
  primary,
  onConnect,
  copies,
  readAt,
  onRetry,
}: {
  /** Connect a directory holds the screen's one gold while this tab shows. */
  primary: boolean;
  onConnect: () => void;
  /** `list_working_copies`, as the page read it. */
  copies: Load<WorkingCopies>;
  /** When the read settled: the instant every last-seen time is relative to. */
  readAt: Date | null;
  onRetry: () => void;
}) {
  const t = useTranslations("repositories.copies");
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
        <CopiesBody copies={copies} readAt={readAt} onRetry={onRetry} />
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
              {SYNC.map(({ key, command }) => (
                <div key={key} className="contents" data-command={command}>
                  <dt className={`${mono} text-dim`}>{command}</dt>
                  <dd className="text-foreground">
                    {t.rich(`sync.${key}`, { code })}
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

/** The panel's body in each state the read can be in. */
function CopiesBody({
  copies,
  readAt,
  onRetry,
}: {
  copies: Load<WorkingCopies>;
  readAt: Date | null;
  onRetry: () => void;
}) {
  const t = useTranslations("repositories.copies");
  const columns = useTranslations("repositories.copies.columns");
  const failureText = useRepositoriesFailure();
  if (copies.kind === "loading")
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t("loading")}
        data-testid="working-copies-loading"
        className="flex flex-col gap-2 px-4 py-3.5"
      >
        {[0, 1, 2].map((row) => (
          <div key={row} className="skeleton h-9 rounded-md" />
        ))}
      </div>
    );
  if (copies.kind === "failed")
    return copies.failure.reason === "denied" ? (
      <p
        data-testid="working-copies-denied"
        data-state="denied"
        className="px-4 py-3.5 text-[13px] leading-relaxed text-muted-foreground"
      >
        {t("denied")}
      </p>
    ) : (
      <div className="flex flex-col items-start gap-2.5 px-4 py-3.5">
        <FormAlert testId="working-copies-failure">
          {copies.failure.reason === "unavailable" ||
          copies.failure.reason === "exhausted"
            ? t("unavailable", { code: copies.failure.code })
            : failureText(copies.failure)}
        </FormAlert>
        <button
          type="button"
          data-testid="working-copies-retry"
          className={buttonSmall}
          onClick={onRetry}
        >
          {t("retry")}
        </button>
      </div>
    );
  const rows = copies.value.workingCopies;
  return (
    <>
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
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={COPY_COLUMNS.length}
                  data-testid="working-copies-empty"
                  data-state="empty"
                  className={`${cell} text-[13px] leading-relaxed text-muted-foreground`}
                >
                  {t.rich("empty", { code })}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <CopyRow key={row.id} row={row} readAt={readAt} />
              ))
            )}
          </tbody>
        </table>
      </div>
      {rows.length >= WORKING_COPY_LIMIT ? (
        <p
          data-testid="working-copies-truncated"
          className="px-4 pb-3 pt-2 text-xs text-dim"
        >
          {t("truncated", { limit: WORKING_COPY_LIMIT })}
        </p>
      ) : null}
    </>
  );
}

function CopyRow({ row, readAt }: { row: WorkingCopy; readAt: Date | null }) {
  const t = useTranslations("repositories.copies");
  const format = useFormatter();
  const seen = new Date(row.lastSeenAt);
  return (
    <tr data-testid={`working-copy-${row.id}`} data-copy={row.id}>
      <td className={cell}>
        <span className="block text-[12px] text-muted-foreground">
          {row.hostname}
        </span>
        <code
          data-testid={`working-copy-path-${row.id}`}
          className={`${mono} block select-all break-all text-foreground`}
        >
          {row.directory}
        </code>
      </td>
      <td className={cell}>
        {row.repository === null ? (
          <span className="text-dim">{t("noRemote")}</span>
        ) : (
          <span className={`${mono} break-all`}>{row.repository}</span>
        )}
      </td>
      <td className={cell}>
        {row.branch === null ? (
          <span className="text-dim">{t("detached")}</span>
        ) : (
          <span className={`${mono} break-all`}>{row.branch}</span>
        )}
        {row.headCommit === null ? null : (
          <span className={`${mono} block text-[11px] text-dim`}>
            {t("head", { commit: short(row.headCommit) })}
          </span>
        )}
      </td>
      <td className={cell}>
        {row.oxagenPresent ? (
          <Badge tone="allowed" data-oxagen="present">
            {t("oxagenState.present")}
          </Badge>
        ) : (
          <Badge tone="quiet" data-oxagen="absent">
            {t("oxagenState.absent")}
          </Badge>
        )}
      </td>
      <td className={cell}>
        <Badge
          tone={
            row.symlinks === "linked"
              ? "allowed"
              : row.symlinks === "missing"
                ? "denied"
                : "quiet"
          }
          dot={row.symlinks !== "none"}
          data-symlinks={row.symlinks}
        >
          {t(`symlinkState.${row.symlinks}`)}
        </Badge>
      </td>
      <td className={cell}>
        {row.pulledCommit === null ? (
          <span className="text-dim" data-pulled="never">
            {t("neverPulled")}
          </span>
        ) : (
          <span
            className={mono}
            data-pulled={row.pulledCommit}
            title={row.pulledCommit}
          >
            {short(row.pulledCommit)}
          </span>
        )}
      </td>
      <td className={`${cell} whitespace-nowrap`}>
        <time
          dateTime={row.lastSeenAt}
          title={format.dateTime(seen, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        >
          {readAt === null
            ? format.dateTime(seen, { dateStyle: "medium", timeStyle: "short" })
            : format.relativeTime(seen, readAt)}
        </time>
        <span className="block text-[11px] text-dim">
          {row.reportedBy === null
            ? t("reportedByKey")
            : row.reportedBy.name === null
              ? t("reportedByUnnamed")
              : t("reportedBy", { name: row.reportedBy.name })}
        </span>
      </td>
    </tr>
  );
}

/**
 * Connect a directory (mockup `DLG_EXT.linkdir`): the three commands to run in
 * the directory, what they write and report, what they do not read, and that
 * linking grants nothing. The design's pairing code is gone: `oxagen init`
 * authenticates as the signed-in person and names the org and workspace, and
 * its report is what puts the directory on the Working copies tab.
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
  const commands = [
    "oxagen login",
    `oxagen init --org ${org} --workspace ${ws}`,
    "oxagen pull",
  ] as const;

  async function copy() {
    try {
      await navigator.clipboard.writeText(commands.join("\n"));
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
        <p className="text-sm leading-relaxed text-foreground">
          {t.rich("lead", { code })}
        </p>
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
            {`${commands[0]}  `}
            <span className="text-code-comment">{t("loginComment")}</span>
            {`\n${commands[1]}\n${commands[2]}`}
          </pre>
          <p
            data-testid="linkdir-hint"
            className="mt-1.5 text-xs text-muted-foreground"
          >
            {t.rich("hint", { code })}
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
            rows={(["writes", "reports", "pull", "noRead"] as const).map(
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
