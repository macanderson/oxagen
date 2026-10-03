// One file's change as the forge wrote it (ADR-292): its unified hunks, read
// in order, each line numbered on the old side, the new side, or both. A hunk
// header row opens each hunk. Added and removed lines take the allowed and
// denied hues. The forge's "No newline at end of file" marker is skipped.
//
// A file can arrive with no hunks for four reasons, and each says which:
// Oxagen did not keep the revision's bytes (the status names why), the file
// is binary, the answer ran out of room before it, or its own hunks were cut
// at their cap, in which case the hunks that fit are drawn first.
//
// No hook state and no "use client": the Run page's Linked work draws the
// patch lines on the server, and the change set draws them in the browser.
import { useTranslations } from "next-intl";
import type { RevisionDiff } from "@/data/contracts/changes";

type DiffFile = RevisionDiff["files"][number];
type DiffStatus = RevisionDiff["diffStatus"];

type DiffLine = {
  kind: "add" | "del" | "ctx" | "hunk";
  old: number | null;
  new: number | null;
  text: string;
};

/** A unified patch as numbered lines: the forge's hunks, read in order. */
function diffLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldAt = 0;
  let newAt = 0;
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk !== null) {
      oldAt = Number(hunk[1]);
      newAt = Number(hunk[2]);
      lines.push({ kind: "hunk", old: null, new: null, text: raw });
    } else if (raw.startsWith("+")) {
      lines.push({ kind: "add", old: null, new: newAt, text: raw.slice(1) });
      newAt += 1;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", old: oldAt, new: null, text: raw.slice(1) });
      oldAt += 1;
    } else if (!raw.startsWith("\\")) {
      lines.push({ kind: "ctx", old: oldAt, new: newAt, text: raw.slice(1) });
      oldAt += 1;
      newAt += 1;
    }
  }
  return lines;
}

/**
 * `.diff { background:var(--void); border:1px solid var(--border);
 * border-radius:9px; font-size:11.5px; line-height:1.6; max-height:360px }`
 * (the `.lw-files` height) and `.dl` (two 34px number columns, then the
 * line), `.dl.add` / `.dl.del` at 14% of the allowed and denied hues.
 */
const DIFF_ROW: Record<DiffLine["kind"], string> = {
  add: "bg-success/15 text-foreground",
  del: "bg-warning/15 text-foreground",
  ctx: "",
  hunk: "text-muted-foreground",
};

/** A unified patch, one numbered row per line. */
export function PatchLines({ patch }: { patch: string }) {
  return (
    <div className="mb-2.5 max-h-90 overflow-auto rounded-xl border border-border bg-void font-mono text-xs leading-relaxed">
      {diffLines(patch).map((line, i) => (
        <div
          // A patch's lines are positional.
          // eslint-disable-next-line @eslint-react/no-array-index-key -- a patch never reorders
          key={i}
          data-line={line.kind}
          className={`grid grid-cols-diff whitespace-pre ${DIFF_ROW[line.kind]}`}
        >
          <span className="select-none border-r border-border px-1.5 text-right text-muted-foreground">
            {line.old ?? ""}
          </span>
          <span className="select-none border-r border-border px-1.5 text-right text-muted-foreground">
            {line.new ?? ""}
          </span>
          <span className="whitespace-pre-wrap px-2.5 wrap-anywhere">
            {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            {line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

const quiet = "mb-2.5 text-base text-muted-foreground";

/**
 * One file of a revision's diff: its hunks, or the one sentence that says
 * why it has none. `diffStatus` is the revision's: a file of a revision
 * whose bytes Oxagen did not keep has no hunks, whatever the file is.
 */
export function DiffView({
  file,
  diffStatus,
}: {
  file: DiffFile;
  diffStatus: DiffStatus;
}) {
  const t = useTranslations("ui.diffView");
  const renamed =
    file.previousPath === null ? null : (
      <p className={quiet}>{t("renamedFrom", { path: file.previousPath })}</p>
    );
  if (diffStatus !== "stored")
    return (
      <>
        {renamed}
        <p data-diff-state={diffStatus} className={quiet}>
          {t(`notKept.${diffStatus}`)}
        </p>
      </>
    );
  if (file.binary)
    return (
      <>
        {renamed}
        <p data-diff-state="binary" className={quiet}>
          {t("binary")}
        </p>
      </>
    );
  if (file.patch === null)
    return (
      <>
        {renamed}
        <p data-diff-state="no_room" className={quiet}>
          {t("noRoom")}
        </p>
      </>
    );
  return (
    <>
      {renamed}
      <PatchLines patch={file.patch} />
      {file.truncated ? (
        <p data-diff-state="truncated" className={quiet}>
          {t("truncated")}
        </p>
      ) : null}
    </>
  );
}
