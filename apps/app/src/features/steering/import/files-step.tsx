"use client";
// The Import Markdown dialog's first step (the mockup's `mdimPick`): the drop
// zone with its two buttons, which are the keyboard path, and one row per
// Markdown file with its target, where it lands, and its status. A file the
// review already read shows what parse found in it: its statement count, its
// rule count, or its Cedar error.
import { MARKDOWN_IMPORT_FILE_CHARS_MAX } from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { UploadSimpleIcon } from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Badge, type BadgeTone } from "@/ui/badge";
import { inputBase, mono } from "@/ui/control-styles";
import { Button } from "@/ui/button";
import { Table } from "@/ui/table";
import {
  type ImportFile,
  type ImportTarget,
  IMPORT_PATH_MAX,
  type PickedFile,
  pickedFromDrop,
  pickedFromInput,
  type TargetReason,
} from "./files";
import type { ImportFileResult, ImportPolicy, ParseResult } from "./rows";

/** A select in a table row: the field skin at the row's height. */
export const rowSelect = `${inputBase} h-8 min-h-8 w-auto py-0 text-sm`;

/** The targets in the order the spec lists them (memory-collection spec, Bulk import). */
const TARGETS: readonly ImportTarget[] = [
  "records",
  "memories",
  "policies",
  "skip",
];

/** The reasons a skipped file names in its status. */
const SKIP_REASONS: ReadonlySet<TargetReason> = new Set([
  "index",
  "links",
  "memory",
  "empty",
  "tooLarge",
  "pathTooLong",
]);

export function DropZone({
  disabled,
  onPicked,
  onUnreadable,
}: {
  disabled: boolean;
  onPicked: (picked: PickedFile[]) => void;
  onUnreadable: () => void;
}) {
  const t = useTranslations("steering.import.drop");
  const filesRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  const fromInput = (input: HTMLInputElement) => {
    const list = Array.from(input.files ?? []);
    // Cleared, so choosing the same files again reads them again.
    input.value = "";
    if (list.length > 0) onPicked(pickedFromInput(list));
  };
  return (
    <div
      data-testid="import-drop"
      data-over={over ? "" : undefined}
      onDragOver={(event) => {
        if (disabled || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (disabled) return;
        // The entries are read before the event ends; the walk runs after.
        pickedFromDrop(event.dataTransfer).then(onPicked, onUnreadable);
      }}
      className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-rule px-4 py-3.5 text-muted-foreground transition-colors data-[over]:border-gold data-[over]:bg-hl"
    >
      <UploadSimpleIcon aria-hidden="true" className="size-4.5 flex-none" />
      <span className="min-w-44 grow text-sm font-medium text-foreground">
        {t("label")}
      </span>
      <Button
        type="button"
        data-touch-target=""
        variant="outline" size="sm"
        disabled={disabled}
        onClick={() => {
          filesRef.current?.click();
        }}
      >
        {t("chooseFiles")}
      </Button>
      <Button
        type="button"
        data-touch-target=""
        variant="outline" size="sm"
        disabled={disabled}
        onClick={() => {
          folderRef.current?.click();
        }}
      >
        {t("chooseFolder")}
      </Button>
      <input
        ref={filesRef}
        type="file"
        multiple
        accept=".md,.markdown,text/markdown"
        hidden
        aria-label={t("filesInput")}
        data-testid="import-files-input"
        onChange={(event) => {
          fromInput(event.currentTarget);
        }}
      />
      <input
        ref={(element) => {
          folderRef.current = element;
          // React passes no `webkitdirectory` prop, so the folder picker is
          // asked for by its attribute.
          element?.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        hidden
        aria-label={t("folderInput")}
        data-testid="import-folder-input"
        onChange={(event) => {
          fromInput(event.currentTarget);
        }}
      />
    </div>
  );
}

type Status = { tone: BadgeTone; text: string; note: string | null };

function useFileStatus(): (
  file: ImportFile,
  result: ImportFileResult | null,
  policy: ImportPolicy | null,
) => Status {
  const t = useTranslations("steering.import");
  const reasonNote = (reason: TargetReason): string | null => {
    switch (reason) {
      case "index":
        return t("reasons.index");
      case "links":
        return t("reasons.links");
      case "memory":
        return t("reasons.memory");
      case "empty":
        return t("reasons.empty");
      case "tooLarge":
        return t("reasons.tooLarge", { max: MARKDOWN_IMPORT_FILE_CHARS_MAX });
      case "pathTooLong":
        return t("reasons.pathTooLong", { max: IMPORT_PATH_MAX });
      case "prose":
      case "cedar":
        return null;
    }
  };
  return (file, result, policy) => {
    if (file.target === "skip") {
      return {
        tone: "quiet",
        text: t("status.skipped"),
        note: SKIP_REASONS.has(file.reason) ? reasonNote(file.reason) : null,
      };
    }
    if (result?.error != null) {
      return { tone: "failed", text: t("status.notRead"), note: result.error };
    }
    if (file.target === "policies" && policy !== null) {
      const issue = policy.issues[0];
      if (issue !== undefined) {
        return {
          tone: "failed",
          text:
            issue.line === null
              ? t("status.cedarProblem")
              : t("status.cedarError", { line: issue.line }),
          note: issue.message,
        };
      }
      if (policy.duplicate !== null) {
        return {
          tone: "quiet",
          text: t("status.skipped"),
          note: t("status.matchesPolicy", { path: policy.duplicate.path }),
        };
      }
      return {
        tone: "allowed",
        text: t("status.rules", { count: policy.statements.length }),
        note: policy.replaces
          ? t("status.replacesPolicy", { path: policy.path })
          : null,
      };
    }
    if (file.target === "records" && result !== null) {
      return {
        tone: "allowed",
        text: t("status.ready"),
        note: t("status.statements", { count: result.records }),
      };
    }
    if (file.target === "memories" && result !== null) {
      return {
        tone: "allowed",
        text: t("status.ready"),
        note: t("status.statements", { count: result.memories }),
      };
    }
    return { tone: "allowed", text: t("status.ready"), note: null };
  };
}

/** The file table. A file the last review read under its target shows what parse found. */
export function FilesTable({
  files,
  parsed,
  disabled,
  onTarget,
}: {
  files: readonly ImportFile[];
  parsed: ParseResult | null;
  disabled: boolean;
  onTarget: (path: string, target: ImportTarget) => void;
}) {
  const t = useTranslations("steering.import");
  const statusOf = useFileStatus();
  return (
    <Table
      label={t("files.label")}
      columns={[
        { label: t("files.columns.file") },
        { label: t("files.columns.target") },
        { label: t("files.columns.path") },
        { label: t("files.columns.status") },
      ]}
    >
      {files.map((file) => {
        const result =
          parsed?.files.find(
            (r) => r.filename === file.path && r.target === file.target,
          ) ?? null;
        const policy =
          result === null
            ? null
            : (parsed?.policies.find((p) => p.file === file.path) ?? null);
        const status = statusOf(file, result, policy);
        return (
          <tr key={file.path} data-file={file.path} data-target={file.target}>
            <td>
              <span className={`block ${mono} text-foreground`}>
                {file.path}
              </span>
              <span className="mt-0.5 block text-xs text-dim">
                {t("files.lines", { count: file.lines })}
              </span>
            </td>
            <td>
              <select
                aria-label={t("files.targetLabel", { file: file.path })}
                data-testid="import-target"
                value={file.target}
                disabled={disabled || file.locked}
                onChange={(event) => {
                  const picked = TARGETS.find((x) => x === event.target.value);
                  if (picked !== undefined) onTarget(file.path, picked);
                }}
                className={rowSelect}
              >
                {TARGETS.map((target) => (
                  <option key={target} value={target}>
                    {t(`targets.${target}`)}
                  </option>
                ))}
              </select>
            </td>
            <td>
              {file.target === "skip" ? (
                <span className="text-muted-foreground">{t("paths.none")}</span>
              ) : file.target === "memories" ? (
                <span className="text-foreground">{t("paths.memories")}</span>
              ) : (
                <span className={`${mono} text-foreground`}>
                  {file.target === "records"
                    ? t("paths.records")
                    : (policy?.path ?? t("paths.policies"))}
                </span>
              )}
            </td>
            <td>
              <Badge tone={status.tone} data-status={status.tone}>
                {status.text}
              </Badge>
              {status.note === null ? null : (
                <span
                  data-truncate={status.note}
                  className="mt-0.5 block max-w-cell truncate text-xs text-dim"
                >
                  {status.note}
                </span>
              )}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}
