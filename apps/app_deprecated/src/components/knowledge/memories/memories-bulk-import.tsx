"use client";

/**
 * MemoriesBulkImport — the bulk "upload skill files → graph memories" flow.
 *
 * Three stages inside one wide Sheet:
 *   1. select  — drop / pick markdown documents (skill files, rule docs,
 *      playbooks); set an optional default anchor; "Parse documents".
 *   2. review  — an editable grid of the draft memories the parser proposed.
 *      Every row is editable (lesson, class, kind, enforcement, source) and
 *      can be included/excluded; skipped documents are surfaced. "Import N
 *      memories".
 *   3. result  — per-row import outcome (imported / failed counts), then Done.
 *
 * parse + commit are server actions threaded in from MemoriesSection. parse is
 * read-only (returns drafts); commit writes each draft into the AgentMemory
 * graph with per-item error capture, so one bad row never fails the batch.
 *
 * Drafts follow the two-axis memory model (docs/specs/two-axis-memory/DESIGN.md):
 * memoryClass (OBSERVATION/RULE/FACT) + memoryKind (open string), with
 * enforcementScore only meaningful for RULE.
 */

import * as React from "react";
import {
  Upload,
  FileText,
  X,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ArrowLeft,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  ALL_CLASSES,
  CLASS_CONFIG,
  RECOMMENDED_MEMORY_KINDS,
  type MemoryClass,
} from "./memory-kinds";

// ---------------------------------------------------------------------------
// Types — structural mirrors of the server-action exports (avoids importing
// "use server" functions / zod schemas into client code; TS checks structurally)
// ---------------------------------------------------------------------------

/** The draft memory shape that round-trips through the grid (= MemoryImportDraft). */
export interface DraftMemory {
  lesson: string;
  memoryClass: MemoryClass;
  memoryKind: string;
  enforcementScore?: number;
  source: string;
  nodeRef: string;
  sourceDocument: string;
  classified: boolean;
}

interface SkippedDocument {
  filename: string;
  reason: string;
}

interface CommitItemResult {
  lesson: string;
  ok: boolean;
  memoryId: string | null;
  error: string | null;
}

type ParseImportResult =
  | {
      ok: true;
      drafts: DraftMemory[];
      documentCount: number;
      skipped: SkippedDocument[];
    }
  | { ok: false; error: string };

type CommitImportResult =
  | { ok: true; results: CommitItemResult[]; imported: number; failed: number }
  | { ok: false; error: string };

interface MemoriesBulkImportProps {
  orgSlug: string;
  workspaceSlug: string;
  onClose: () => void;
  /** Called after at least one memory was committed, so the list can refresh. */
  onImported: () => void;
  parseImport: (input: {
    orgSlug: string;
    workspaceSlug: string;
    documents: { filename: string; content: string }[];
    defaultNodeRef?: string;
  }) => Promise<ParseImportResult>;
  commitImport: (input: {
    orgSlug: string;
    workspaceSlug: string;
    drafts: DraftMemory[];
  }) => Promise<CommitImportResult>;
}

// Mirrors the agent.memory.import.parse contract caps for friendly pre-flight
// validation; the server re-checks authoritatively.
const MAX_DOCS = 25;
const MAX_DOC_BYTES = 100_000;
const ACCEPTED_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"];

const FIELD_CLS =
  "w-full rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50";

// ---------------------------------------------------------------------------
// A picked-but-not-yet-parsed local file
// ---------------------------------------------------------------------------

interface PickedFile {
  filename: string;
  content: string;
  bytes: number;
}

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// A row in the editable review grid — a draft plus its UI include flag.
interface EditableDraft extends DraftMemory {
  include: boolean;
}

// ---------------------------------------------------------------------------
// Stage 1 — file selection
// ---------------------------------------------------------------------------

function SelectStage({
  files,
  setFiles,
  defaultNodeRef,
  setDefaultNodeRef,
  onParse,
  isPending,
  error,
  onClose,
}: {
  files: PickedFile[];
  setFiles: React.Dispatch<React.SetStateAction<PickedFile[]>>;
  defaultNodeRef: string;
  setDefaultNodeRef: (v: string) => void;
  onParse: () => void;
  isPending: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [localNotice, setLocalNotice] = React.useState<string | null>(null);

  const addFiles = React.useCallback(
    async (fileList: FileList | File[]) => {
      const incoming = Array.from(fileList);
      const accepted: PickedFile[] = [];
      const rejected: string[] = [];
      for (const f of incoming) {
        if (!hasAcceptedExtension(f.name)) {
          rejected.push(f.name);
          continue;
        }
        // Check the declared size BEFORE reading. `f.text()` pulls the whole
        // file into a JS string, so reading first would let a single dropped
        // multi-hundred-MB file exhaust the tab's memory before the oversized
        // check below ever ran. An oversized file is still listed (so the row
        // and its "must be split" warning appear, and Parse stays disabled) —
        // it just carries no content.
        const content = f.size > MAX_DOC_BYTES ? "" : await f.text();
        accepted.push({ filename: f.name, content, bytes: f.size });
      }
      setFiles((prev) => {
        // De-dup by filename; newest content wins.
        const byName = new Map(prev.map((p) => [p.filename, p]));
        for (const a of accepted) byName.set(a.filename, a);
        return Array.from(byName.values()).slice(0, MAX_DOCS);
      });
      if (rejected.length > 0) {
        setLocalNotice(
          `Skipped ${rejected.length} unsupported file${rejected.length === 1 ? "" : "s"} (only ${ACCEPTED_EXTENSIONS.join(", ")}).`,
        );
      } else {
        setLocalNotice(null);
      }
    },
    [setFiles],
  );

  function removeFile(name: string) {
    setFiles((prev) => prev.filter((f) => f.filename !== name));
  }

  const oversized = files.filter((f) => f.bytes > MAX_DOC_BYTES);
  const atCap = files.length >= MAX_DOCS;

  return (
    <div className="flex flex-col gap-4">
      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload markdown documents"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors cursor-pointer ${
          dragging
            ? "border-primary bg-primary/5"
            : "border-border/60 hover:border-border hover:bg-muted/30"
        }`}
      >
        <Upload className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium text-foreground">
          Drop markdown files here, or click to choose
        </p>
        <p className="text-[11px] text-muted-foreground">
          Skill files, rule docs, runbooks — {ACCEPTED_EXTENSIONS.join(", ")} ·
          up to {MAX_DOCS} files
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(",")}
          aria-label="Choose markdown documents"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            // Reset so re-picking the same file re-fires onChange.
            e.target.value = "";
          }}
        />
      </div>

      {localNotice && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400">
          {localNotice}
        </p>
      )}

      {/* Selected file list */}
      {files.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {files.length} document{files.length === 1 ? "" : "s"} selected
            </span>
            <button
              type="button"
              onClick={() => setFiles([])}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              Clear all
            </button>
          </div>
          <ul className="flex flex-col gap-1 max-h-48 overflow-y-auto">
            {files.map((f) => {
              const tooBig = f.bytes > MAX_DOC_BYTES;
              return (
                <li
                  key={f.filename}
                  className="flex items-center gap-2 rounded-md border border-border/50 px-2.5 py-1.5"
                >
                  <FileText
                    className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span
                    className="flex-1 truncate text-xs text-foreground"
                    title={f.filename}
                  >
                    {f.filename}
                  </span>
                  <span
                    className={`text-[10px] tabular-nums ${tooBig ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {formatBytes(f.bytes)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${f.filename}`}
                    onClick={() => removeFile(f.filename)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
          {atCap && (
            <p className="text-[10px] text-muted-foreground">
              At the {MAX_DOCS}-file limit. Remove a file to add another, or
              import in batches.
            </p>
          )}
          {oversized.length > 0 && (
            <p className="text-[10px] text-destructive">
              {oversized.length} file{oversized.length === 1 ? " is" : "s are"}{" "}
              over {formatBytes(MAX_DOC_BYTES)} and must be split before import.
            </p>
          )}
        </div>
      )}

      {/* Default anchor */}
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="bulk-import-node-ref"
          className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Default anchor (optional)
        </label>
        <input
          id="bulk-import-node-ref"
          type="text"
          value={defaultNodeRef}
          onChange={(e) => setDefaultNodeRef(e.target.value)}
          maxLength={256}
          placeholder="user-memory"
          aria-label="Default node ref"
          disabled={isPending}
          className={FIELD_CLS}
        />
        <p className="text-[10px] text-muted-foreground">
          The graph node every imported memory anchors to. Defaults to the
          shared &ldquo;user-memory&rdquo; bucket.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 pt-3 border-t border-border/40">
        <Button
          size="sm"
          variant="gradient"
          onClick={onParse}
          disabled={isPending || files.length === 0 || oversized.length > 0}
        >
          {isPending ? (
            <>
              <Loader2
                className="h-3.5 w-3.5 mr-1.5 animate-spin"
                aria-hidden="true"
              />
              Parsing…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
              Parse documents
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          disabled={isPending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 2 — editable review grid
// ---------------------------------------------------------------------------

function ReviewStage({
  drafts,
  setDrafts,
  skipped,
  onBack,
  onImport,
  isPending,
  error,
}: {
  drafts: EditableDraft[];
  setDrafts: React.Dispatch<React.SetStateAction<EditableDraft[]>>;
  skipped: SkippedDocument[];
  onBack: () => void;
  onImport: () => void;
  isPending: boolean;
  error: string | null;
}) {
  const selectedCount = drafts.filter((d) => d.include).length;
  const allSelected = drafts.length > 0 && selectedCount === drafts.length;

  function patch(index: number, updates: Partial<EditableDraft>) {
    setDrafts((prev) =>
      prev.map((d, i) => (i === index ? { ...d, ...updates } : d)),
    );
  }

  function toggleAll() {
    const next = !allSelected;
    setDrafts((prev) => prev.map((d) => ({ ...d, include: next })));
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Skipped documents notice */}
      {skipped.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {skipped.length} document{skipped.length === 1 ? "" : "s"} produced
            no memories
          </p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {skipped.map((s) => (
              <li
                key={s.filename}
                className="text-[10px] text-muted-foreground"
              >
                <span className="font-mono">{s.filename}</span> — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {drafts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 py-10 text-center">
          <FileText
            className="h-7 w-7 text-muted-foreground/50"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-muted-foreground">
            No memories were extracted
          </p>
          <p className="max-w-xs text-xs text-muted-foreground/70">
            None of the uploaded documents contained durable rules. Try
            different files or add memories manually.
          </p>
        </div>
      ) : (
        <>
          {/* Grid toolbar */}
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
              <input
                type="checkbox"
                checked={allSelected}
                aria-label="Select all drafts"
                onChange={toggleAll}
                className="h-3.5 w-3.5 accent-primary"
              />
              Select all
            </label>
            <span className="text-[11px] text-muted-foreground">
              {selectedCount} of {drafts.length} selected
            </span>
          </div>

          {/* Editable grid */}
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <div className="min-w-[900px]">
              {/* Header row */}
              <div className="grid grid-cols-[2rem_minmax(0,1fr)_8rem_7rem_6rem_8rem] gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span aria-hidden="true" />
                <span>Lesson</span>
                <span>Kind</span>
                <span>Class</span>
                <span>Enforce</span>
                <span>Source</span>
              </div>
              {/* Body rows */}
              <div className="max-h-[460px] overflow-y-auto">
                {drafts.map((draft, i) => (
                  <div
                    key={i}
                    className={`grid grid-cols-[2rem_minmax(0,1fr)_8rem_7rem_6rem_8rem] items-start gap-2 border-b border-border/30 px-3 py-2 last:border-b-0 ${
                      draft.include ? "" : "opacity-50"
                    }`}
                  >
                    {/* Include */}
                    <div className="pt-1.5">
                      <input
                        type="checkbox"
                        checked={draft.include}
                        aria-label={`Include draft ${i + 1}`}
                        onChange={(e) =>
                          patch(i, { include: e.target.checked })
                        }
                        className="h-3.5 w-3.5 accent-primary"
                      />
                    </div>

                    {/* Lesson + provenance */}
                    <div className="flex flex-col gap-1">
                      <textarea
                        rows={2}
                        value={draft.lesson}
                        aria-label={`Lesson for draft ${i + 1}`}
                        maxLength={2000}
                        disabled={isPending}
                        onChange={(e) => patch(i, { lesson: e.target.value })}
                        className={`${FIELD_CLS} resize-y leading-snug`}
                      />
                      {draft.sourceDocument && (
                        <span
                          className="truncate text-[10px] text-muted-foreground"
                          title={draft.sourceDocument}
                        >
                          from {draft.sourceDocument}
                          {draft.classified ? " · auto-classified" : ""}
                        </span>
                      )}
                    </div>

                    {/* Kind — open string, recommended values suggested */}
                    <div>
                      <input
                        type="text"
                        list={`draft-kind-options-${i}`}
                        value={draft.memoryKind}
                        aria-label={`Kind for draft ${i + 1}`}
                        maxLength={64}
                        disabled={isPending}
                        onChange={(e) =>
                          patch(i, {
                            memoryKind: e.target.value,
                            classified: false,
                          })
                        }
                        className={FIELD_CLS}
                      />
                      <datalist id={`draft-kind-options-${i}`}>
                        {RECOMMENDED_MEMORY_KINDS.map((k) => (
                          <option key={k} value={k} />
                        ))}
                      </datalist>
                    </div>

                    {/* Class */}
                    <select
                      value={draft.memoryClass}
                      aria-label={`Class for draft ${i + 1}`}
                      disabled={isPending}
                      onChange={(e) =>
                        patch(i, {
                          memoryClass: e.target.value as MemoryClass,
                          classified: false,
                        })
                      }
                      className={FIELD_CLS}
                    >
                      {ALL_CLASSES.map((c) => (
                        <option key={c} value={c}>
                          {CLASS_CONFIG[c].label}
                        </option>
                      ))}
                    </select>

                    {/* Enforcement — only meaningful for RULE */}
                    {draft.memoryClass === "RULE" ? (
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={draft.enforcementScore ?? 50}
                        aria-label={`Enforcement for draft ${i + 1}`}
                        disabled={isPending}
                        onChange={(e) =>
                          patch(i, {
                            enforcementScore: Number(e.target.value),
                            classified: false,
                          })
                        }
                        className={FIELD_CLS}
                      />
                    ) : (
                      <span className="pt-1.5 text-[10px] text-muted-foreground">
                        {draft.memoryClass === "FACT" ? "100" : "—"}
                      </span>
                    )}

                    {/* Source */}
                    <input
                      type="text"
                      value={draft.source}
                      aria-label={`Source for draft ${i + 1}`}
                      maxLength={64}
                      disabled={isPending}
                      onChange={(e) => patch(i, { source: e.target.value })}
                      className={FIELD_CLS}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between gap-2 pt-3 border-t border-border/40">
        <Button size="sm" variant="ghost" onClick={onBack} disabled={isPending}>
          <ArrowLeft className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
          Back
        </Button>
        <Button
          size="sm"
          variant="gradient"
          onClick={onImport}
          disabled={isPending || selectedCount === 0}
        >
          {isPending ? (
            <>
              <Loader2
                className="h-3.5 w-3.5 mr-1.5 animate-spin"
                aria-hidden="true"
              />
              Importing…
            </>
          ) : (
            <>
              Import {selectedCount} memor{selectedCount === 1 ? "y" : "ies"}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 3 — import results
// ---------------------------------------------------------------------------

function ResultStage({
  results,
  imported,
  failed,
  onDone,
}: {
  results: CommitItemResult[];
  imported: number;
  failed: number;
  onDone: () => void;
}) {
  const failures = results.filter((r) => !r.ok);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4 rounded-lg border border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <CheckCircle2
            className="h-5 w-5 text-emerald-500"
            aria-hidden="true"
          />
          <div className="flex flex-col">
            <span className="text-lg font-semibold tabular-nums text-foreground">
              {imported}
            </span>
            <span className="text-[10px] text-muted-foreground">imported</span>
          </div>
        </div>
        {failed > 0 && (
          <div className="flex items-center gap-2">
            <AlertTriangle
              className="h-5 w-5 text-destructive"
              aria-hidden="true"
            />
            <div className="flex flex-col">
              <span className="text-lg font-semibold tabular-nums text-foreground">
                {failed}
              </span>
              <span className="text-[10px] text-muted-foreground">failed</span>
            </div>
          </div>
        )}
      </div>

      {failures.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Failed rows
          </span>
          <ul className="flex flex-col gap-1 max-h-56 overflow-y-auto">
            {failures.map((f, i) => (
              <li
                key={i}
                className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5"
              >
                <p
                  className="line-clamp-1 text-xs text-foreground"
                  title={f.lesson}
                >
                  {f.lesson}
                </p>
                <p className="text-[10px] text-destructive">
                  {f.error ?? "Unknown error"}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {imported > 0 && failed === 0 && (
        <p className="text-xs text-muted-foreground">
          All set — the imported memories now appear in the list.
        </p>
      )}

      <div className="flex items-center gap-2 pt-3 border-t border-border/40">
        <Button size="sm" variant="gradient" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component — stage orchestration
// ---------------------------------------------------------------------------

type Stage = "select" | "review" | "result";

export function MemoriesBulkImport({
  orgSlug,
  workspaceSlug,
  onClose,
  onImported,
  parseImport,
  commitImport,
}: MemoriesBulkImportProps) {
  const [stage, setStage] = React.useState<Stage>("select");
  const [files, setFiles] = React.useState<PickedFile[]>([]);
  const [defaultNodeRef, setDefaultNodeRef] = React.useState("");
  const [drafts, setDrafts] = React.useState<EditableDraft[]>([]);
  const [skipped, setSkipped] = React.useState<SkippedDocument[]>([]);
  const [commitResults, setCommitResults] = React.useState<CommitItemResult[]>(
    [],
  );
  const [imported, setImported] = React.useState(0);
  const [failed, setFailed] = React.useState(0);
  const [isPending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function handleParse() {
    setError(null);
    startTransition(async () => {
      const result = await parseImport({
        orgSlug,
        workspaceSlug,
        documents: files.map((f) => ({
          filename: f.filename,
          content: f.content,
        })),
        ...(defaultNodeRef.trim()
          ? { defaultNodeRef: defaultNodeRef.trim() }
          : {}),
      });
      if (result.ok) {
        setDrafts(result.drafts.map((d) => ({ ...d, include: true })));
        setSkipped(result.skipped);
        setStage("review");
      } else {
        setError(result.error);
      }
    });
  }

  function handleImport() {
    setError(null);
    // Strip the UI-only `include` flag; send the bare draft contract shape.
    const selected: DraftMemory[] = drafts
      .filter((d) => d.include)
      .map((d) => ({
        lesson: d.lesson,
        memoryClass: d.memoryClass,
        memoryKind: d.memoryKind,
        ...(d.memoryClass === "RULE"
          ? { enforcementScore: d.enforcementScore ?? 50 }
          : {}),
        source: d.source,
        nodeRef: d.nodeRef,
        sourceDocument: d.sourceDocument,
        classified: d.classified,
      }));
    if (selected.length === 0) return;

    startTransition(async () => {
      const result = await commitImport({
        orgSlug,
        workspaceSlug,
        drafts: selected,
      });
      if (result.ok) {
        setCommitResults(result.results);
        setImported(result.imported);
        setFailed(result.failed);
        if (result.imported > 0) onImported();
        setStage("result");
      } else {
        setError(result.error);
      }
    });
  }

  function handleClose() {
    onClose();
  }

  const titleByStage: Record<Stage, string> = {
    select: "Bulk import memories",
    review: "Review draft memories",
    result: "Import complete",
  };
  const descriptionByStage: Record<Stage, string> = {
    select:
      "Upload markdown skill files, rule docs, or runbooks. Each is parsed into atomic memories you can review before importing.",
    review:
      "Edit any field, deselect rows you don't want, then import. Kind and class were classified by the assistant.",
    result: "",
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !isPending) handleClose();
      }}
    >
      <SheetContent className="flex w-full max-w-4xl flex-col overflow-y-auto sm:max-w-4xl">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4" aria-hidden="true" />
            {titleByStage[stage]}
          </SheetTitle>
          {descriptionByStage[stage] && (
            <SheetDescription className="text-xs text-muted-foreground">
              {descriptionByStage[stage]}
            </SheetDescription>
          )}
        </SheetHeader>

        {stage === "select" && (
          <SelectStage
            files={files}
            setFiles={setFiles}
            defaultNodeRef={defaultNodeRef}
            setDefaultNodeRef={setDefaultNodeRef}
            onParse={handleParse}
            isPending={isPending}
            error={error}
            onClose={handleClose}
          />
        )}

        {stage === "review" && (
          <ReviewStage
            drafts={drafts}
            setDrafts={setDrafts}
            skipped={skipped}
            onBack={() => {
              setError(null);
              setStage("select");
            }}
            onImport={handleImport}
            isPending={isPending}
            error={error}
          />
        )}

        {stage === "result" && (
          <ResultStage
            results={commitResults}
            imported={imported}
            failed={failed}
            onDone={handleClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
