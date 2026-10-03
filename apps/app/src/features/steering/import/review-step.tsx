"use client";
// The Import Markdown dialog's statement grid (the mockup's `mdimReview` and
// `mdimRowHtml`): one group per file, and under a records file one row per
// statement with its kind and the reason for it, its force within the forces
// the kind allows, the words behind the force, the file and line it starts
// on, and any duplicate or conflict. Under a memories file each row is a
// memory with force info, and its mark names the waiting memory, the
// rejected statement, or the earlier row it repeats. A policy file shows its
// head only.
//
// Table text never wraps. The shell's cell overflow shows the whole value of
// a cut line in a hover card, and each line that can be cut carries the whole
// value in `data-truncate`, so a statement's line breaks survive the card.
import { useTranslations } from "next-intl";
import { Badge } from "@/ui/badge";
import { mono } from "@/ui/control-styles";
import { Table } from "@/ui/table";
import { rowSelect } from "./files-step";
import {
  changeEffect,
  changeForce,
  changeKind,
  type FileGroup,
  forceReason,
  forcesOf,
  IMPORT_KINDS,
  type ImportEffect,
  type ImportKind,
  memoryKey,
  type ResolvedMemory,
  type ResolvedRow,
  type RowEdit,
  rowKey,
} from "./rows";

const COLUMNS = 7;

/** A statement on one line, as the grid prints it. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const sub = "mt-0.5 block max-w-cell-narrow truncate text-xs text-dim";

function where(row: ResolvedRow): { line: number; file: string } {
  return { line: row.record.line, file: row.record.file };
}

/** The record a mark names: a published record by its lineage, a row of this import by its file and line. */
function useMatchName(rows: readonly ResolvedRow[]) {
  const t = useTranslations("steering.import.marks");
  return (match: { lineage: string; published: boolean }): string => {
    if (match.published) return match.lineage;
    const row = rows.find((r) => r.record.lineage === match.lineage);
    return row === undefined
      ? match.lineage
      : t("rowRef", { line: row.record.line, file: row.record.file });
  };
}

function KindCell({
  row,
  onEdit,
}: {
  row: ResolvedRow;
  onEdit: (edit: RowEdit) => void;
}) {
  const t = useTranslations("steering.import");
  const { record, edit } = row;
  if (record.origin === "frontmatter") {
    return (
      <>
        <span className="block text-foreground">{t(`kinds.${edit.kind}`)}</span>
        <span className={sub}>{t("grid.fromFrontmatter")}</span>
      </>
    );
  }
  const reason =
    edit.kind === record.kind ? record.kindReason : t("grid.yourChoice");
  return (
    <>
      <span className="flex items-center gap-1.5">
        <select
          aria-label={t("grid.kindLabel", where(row))}
          data-testid="import-kind"
          value={edit.kind}
          onChange={(event) => {
            const kind = IMPORT_KINDS.find((k) => k === event.target.value);
            if (kind !== undefined) onEdit(changeKind(record, edit, kind));
          }}
          className={rowSelect}
        >
          {IMPORT_KINDS.map((kind: ImportKind) => (
            <option key={kind} value={kind}>
              {t(`kinds.${kind}`)}
            </option>
          ))}
        </select>
        {edit.kind === "constraint" ? (
          <select
            aria-label={t("grid.effectLabel", where(row))}
            data-testid="import-effect"
            value={edit.effect ?? "require"}
            onChange={(event) => {
              const effect = EFFECTS.find((e) => e === event.target.value);
              if (effect !== undefined) onEdit(changeEffect(edit, effect));
            }}
            className={rowSelect}
          >
            {EFFECTS.map((effect) => (
              <option key={effect} value={effect}>
                {t(`effects.${effect}`)}
              </option>
            ))}
          </select>
        ) : null}
      </span>
      <span data-truncate={reason} className={sub}>
        {reason}
      </span>
    </>
  );
}

const EFFECTS: readonly ImportEffect[] = ["require", "forbid"];

function ForceCell({
  row,
  onEdit,
}: {
  row: ResolvedRow;
  onEdit: (edit: RowEdit) => void;
}) {
  const t = useTranslations("steering.import.grid");
  const { record, edit } = row;
  const forces = forcesOf(edit.kind);
  const editable = record.origin === "split" && forces.length > 1;
  return (
    <>
      {editable ? (
        <select
          aria-label={t("forceLabel", where(row))}
          data-testid="import-force"
          value={edit.force}
          onChange={(event) => {
            const force = forces.find((f) => f === event.target.value);
            if (force !== undefined) onEdit(changeForce(edit, force));
          }}
          className={`${rowSelect} font-mono`}
        >
          {forces.map((force) => (
            <option key={force} value={force}>
              {force}
            </option>
          ))}
        </select>
      ) : (
        <span className={`${mono} text-foreground`} data-testid="import-force">
          {edit.force}
        </span>
      )}
      {edit.force === "must" || edit.force === "should" ? (
        <span className={sub}>
          {t("tokensPerRequest", { count: record.tokens })}
        </span>
      ) : null}
    </>
  );
}

function WordsCell({ row }: { row: ResolvedRow }) {
  const t = useTranslations("steering.import");
  const { record, edit } = row;
  if (record.origin === "frontmatter") {
    return <span className="text-muted-foreground">{t("grid.kept")}</span>;
  }
  const words = record.forceWords.trim();
  const reason = forceReason(record, edit);
  return (
    <>
      {words === "" ? (
        <span className="text-muted-foreground">{t("grid.none")}</span>
      ) : (
        <span
          data-truncate={words}
          className="block max-w-cell-narrow truncate text-foreground"
        >
          {t("grid.quoted", { words })}
        </span>
      )}
      <span className={sub} data-reason={reason}>
        {t(`why.${reason}`, { force: edit.force })}
      </span>
    </>
  );
}

function MarksCell({
  row,
  rows,
  onEdit,
}: {
  row: ResolvedRow;
  rows: readonly ResolvedRow[];
  onEdit: (edit: RowEdit) => void;
}) {
  const t = useTranslations("steering.import");
  const nameOf = useMatchName(rows);
  const { record, edit } = row;
  const winner = row.replacedBy === null ? undefined : rows[row.replacedBy];
  if (winner !== undefined) {
    return (
      <>
        <Badge tone="quiet" data-mark="replaced">
          {t("marks.replaced")}
        </Badge>
        <span className={sub}>
          {t("marks.replacedBy", {
            line: winner.record.line,
            file: winner.record.file,
          })}
        </span>
      </>
    );
  }
  if (record.conflict !== null) {
    const name = nameOf(record.conflict);
    return (
      <>
        <Badge tone="failed" data-mark="conflict">
          {t("marks.conflict")}
        </Badge>
        <span data-truncate={name} className={sub}>
          {t("marks.conflictsWith", { record: name })}
        </span>
        <select
          aria-label={t("grid.conflictLabel", where(row))}
          data-testid="import-conflict"
          value={edit.choice ?? ""}
          disabled={!edit.on}
          onChange={(event) => {
            const choice = CHOICES.find((c) => c === event.target.value);
            if (choice !== undefined) onEdit({ ...edit, choice });
          }}
          className={`${rowSelect} mt-1`}
        >
          <option value="" disabled>
            {t("choices.choose")}
          </option>
          {CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {t(`choices.${choice}`)}
            </option>
          ))}
        </select>
      </>
    );
  }
  if (record.duplicate !== null) {
    const name = nameOf(record.duplicate);
    return (
      <>
        <Badge tone="quiet" data-mark="duplicate">
          {t("marks.duplicate")}
        </Badge>
        <span data-truncate={name} className={sub}>
          {t("marks.matches", { record: name })}
        </span>
      </>
    );
  }
  return null;
}

const CHOICES = ["keep", "replace"] as const;

function RecordRow({
  index,
  row,
  rows,
  onEdit,
}: {
  index: number;
  row: ResolvedRow;
  rows: readonly ResolvedRow[];
  onEdit: (index: number, edit: RowEdit) => void;
}) {
  const t = useTranslations("steering.import.grid");
  const { record, edit } = row;
  const edited = (next: RowEdit) => {
    onEdit(index, next);
  };
  return (
    <tr
      data-testid="import-row"
      data-lineage={record.lineage}
      data-action={row.action ?? "open"}
    >
      <td>
        <input
          type="checkbox"
          data-testid="import-on"
          aria-label={t("importLabel", where(row))}
          checked={edit.on}
          onChange={(event) => {
            edited({ ...edit, on: event.currentTarget.checked });
          }}
        />
      </td>
      <td>
        <span
          data-truncate={record.statement}
          className={`block max-w-cell-wide truncate ${row.action === "skip" ? "text-muted-foreground" : "text-foreground"}`}
        >
          {oneLine(record.statement)}
        </span>
      </td>
      <td>
        <KindCell row={row} onEdit={edited} />
      </td>
      <td>
        <ForceCell row={row} onEdit={edited} />
      </td>
      <td>
        <WordsCell row={row} />
      </td>
      <td>
        <span className={`${mono} text-muted-foreground`}>
          {record.file}:{record.line}
        </span>
      </td>
      <td>
        <MarksCell row={row} rows={rows} onEdit={edited} />
      </td>
    </tr>
  );
}

/** What a memory row repeats, or why it cannot be stored. */
function MemoryMarks({ memory }: { memory: ResolvedMemory["memory"] }) {
  const t = useTranslations("steering.import.marks");
  const match = memory.duplicate;
  if (match !== null) {
    const note =
      match.reason === "waiting"
        ? t("waiting", { memory: match.memory ?? "" })
        : match.reason === "rejected"
          ? t("rejected")
          : t("matches", {
              record: t("rowRef", { line: match.line ?? 1, file: match.file ?? "" }),
            });
    return (
      <>
        <Badge tone="quiet" data-mark="duplicate">
          {t("duplicate")}
        </Badge>
        <span data-truncate={note} className={sub}>
          {note}
        </span>
      </>
    );
  }
  if (memory.issue !== null) {
    return (
      <>
        <Badge tone="failed" data-mark="too-long">
          {t("tooLong")}
        </Badge>
        <span data-truncate={memory.issue} className={sub}>
          {memory.issue}
        </span>
      </>
    );
  }
  return null;
}

function MemoryRow({
  row,
  onTick,
}: {
  row: ResolvedMemory;
  onTick: (on: boolean) => void;
}) {
  const t = useTranslations("steering.import");
  const { memory } = row;
  const at = { line: memory.line, file: memory.file };
  return (
    <tr
      data-testid="import-memory"
      data-source={`${memory.file}:${String(memory.line)}`}
      data-action={row.action}
    >
      <td>
        <input
          type="checkbox"
          data-testid="import-on"
          aria-label={t("grid.importLabel", at)}
          checked={row.action === "add"}
          disabled={!row.editable}
          onChange={(event) => {
            onTick(event.currentTarget.checked);
          }}
        />
      </td>
      <td>
        <span
          data-truncate={memory.statement}
          className={`block max-w-cell-wide truncate ${row.action === "skip" ? "text-muted-foreground" : "text-foreground"}`}
        >
          {oneLine(memory.statement)}
        </span>
      </td>
      <td>
        <span className="block text-foreground">{t("kinds.memory")}</span>
        <span className={sub}>{t("grid.fromTarget")}</span>
      </td>
      <td>
        <span className={`${mono} text-foreground`} data-testid="import-force">
          {memory.force}
        </span>
      </td>
      <td>
        <span className="text-muted-foreground">{t("grid.none")}</span>
        <span className={sub} data-reason="only">
          {t("why.only", { force: memory.force })}
        </span>
      </td>
      <td>
        <span className={`${mono} text-muted-foreground`}>
          {memory.file}:{memory.line}
        </span>
      </td>
      <td>
        <MemoryMarks memory={memory} />
      </td>
    </tr>
  );
}

/** A file's head row: its path, its target, and what parse made of it. */
function GroupHead({ group }: { group: FileGroup }) {
  const t = useTranslations("steering.import");
  const { result, policy } = group;
  let what: string;
  let problem: string | null = null;
  if (result.error !== null) {
    what = t("grid.notRead");
    problem = result.error;
  } else if (policy !== null) {
    const issue = policy.issues[0];
    what = t("grid.rules", { count: policy.statements.length });
    if (issue !== undefined) problem = issue.message;
  } else {
    what = t("grid.statements", {
      count:
        group.target === "memories" ? group.memories.length : group.rows.length,
    });
  }
  return (
    <tr data-testid="import-group" data-file={group.file}>
      <td
        colSpan={COLUMNS}
        className="bg-hl px-3 py-1.5 text-sm text-muted-foreground"
      >
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`${mono} text-foreground`}>{group.file}</span>
          <span>{t(`targets.${group.target}`)}</span>
          {policy === null ? null : (
            <span className={mono}>{policy.path}</span>
          )}
          <span>{what}</span>
          {policy?.replaces === true ? (
            <Badge tone="approval" data-mark="update">
              {t("marks.update")}
            </Badge>
          ) : null}
          {problem === null ? null : (
            <span role="note" className="text-error-ink">
              {problem}
            </span>
          )}
        </span>
      </td>
    </tr>
  );
}

export function StatementGrid({
  groups,
  rows,
  onEdit,
  onTick,
}: {
  groups: readonly FileGroup[];
  rows: readonly ResolvedRow[];
  onEdit: (index: number, edit: RowEdit) => void;
  /** A memory row ticked in or out. */
  onTick: (memory: ResolvedMemory["memory"], on: boolean) => void;
}) {
  const t = useTranslations("steering.import.grid");
  return (
    <Table
      label={t("label")}
      columns={[
        { label: t("columns.import"), hidden: true },
        { label: t("columns.statement") },
        { label: t("columns.kind") },
        { label: t("columns.force") },
        { label: t("columns.words") },
        { label: t("columns.source") },
        { label: t("columns.marks") },
      ]}
    >
      {groups.flatMap((group) => [
        <GroupHead key={`head:${group.file}`} group={group} />,
        ...group.rows.map(({ index, row }) => (
          <RecordRow
            key={rowKey(row.record)}
            index={index}
            row={row}
            rows={rows}
            onEdit={onEdit}
          />
        )),
        ...group.memories.map((row) => (
          <MemoryRow
            key={memoryKey(row.memory)}
            row={row}
            onTick={(on) => {
              onTick(row.memory, on);
            }}
          />
        )),
      ])}
    </Table>
  );
}
