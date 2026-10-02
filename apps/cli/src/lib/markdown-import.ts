/**
 * The Markdown import that `oxagen memory import` and `oxagen steering import`
 * both run: read the files, send them to parse_markdown_import in calls of 25,
 * mark the duplicates and conflicts between calls, then print the rows, or
 * commit them with commit_markdown_import on --yes. The commit opens one
 * steering PR for the records and policies, and stores the memories as
 * waiting memories.
 *
 * The two commands differ in what they read. `memory import` reads every file
 * as records, so its output and its commit carry no policies. `steering
 * import` reads Cedar policies too, and passes `policies: true`. A file read
 * as memories gives memory rows. Each parse call marks the memories its own
 * files repeat, and the commit checks every memory again, so a memory that
 * repeats one from another call is left out and named there.
 *
 * The commands keep their own lists of the capabilities they call, because
 * the manifest's cli layer looks for the capability names in
 * apps/cli/src/commands and not here.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  MARKDOWN_IMPORT_FILE_CHARS_MAX,
  markdownImportFileCount,
  markdownImportTooManyFiles,
  type MarkdownImportFile,
  type MarkdownImportMemory,
  type MarkdownImportPolicy,
  type MarkdownImportRecord,
  type MarkdownImportTarget,
} from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { STEERING_PR_MAX_FILES } from "@oxagen/oxagen/steering-repo/names";
import { markImportMatches, type ImportMatchRow } from "@oxagen/steering-check";
import { failCommand, type CommandWriter } from "./capture-writer.js";
import {
  commitMarkdownImport,
  formatImportMemories,
  formatImportPolicies,
  formatImportPullRequest,
  formatImportRows,
  MARKDOWN_IMPORT_FILES_PER_CALL,
  parseMarkdownImport,
  type MarkdownImportDocumentInput,
} from "./memory-client.js";

/** A file to import, and the folder a walk found it in, when a walk did. */
export interface ImportSource {
  path: string;
  folder?: string;
}

/** True for a relative path that stays inside the folder it is relative to. */
function inside(rel: string): boolean {
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The name a file is sent under. It is the file's path from here. A file a
 * walk found outside this directory takes its path from the folder's parent,
 * such as docs/release.md, and any other file outside takes its base name.
 * The import builds lineages from these names.
 */
export function importFilename(path: string, folder?: string): string {
  let rel = relative(process.cwd(), path);
  if (!inside(rel) && folder !== undefined) {
    rel = relative(dirname(resolve(folder)), resolve(path));
  }
  const name = inside(rel) ? rel.split(sep).join("/") : basename(path);
  return name.length > 256 ? basename(path).slice(-256) : name;
}

/**
 * Read each file to import. A file that cannot be read, is empty, or is
 * longer than one parse call takes is listed on stderr and left out, so one
 * bad file does not stop the rest. Fails when no file is left.
 *
 * `target` is set on every document when the caller chose one. Without it,
 * parse reads each file with the target its text implies.
 */
export async function readImportDocuments(
  sources: readonly ImportSource[],
  target: MarkdownImportTarget | undefined,
  writer: CommandWriter,
): Promise<MarkdownImportDocumentInput[]> {
  const documents: MarkdownImportDocumentInput[] = [];
  const unreadable: string[] = [];
  const tooLong: string[] = [];
  for (const source of sources) {
    let content: string;
    try {
      content = await readFile(source.path, "utf8");
    } catch {
      unreadable.push(source.path);
      continue;
    }
    if (content.trim().length === 0) {
      unreadable.push(`${source.path} (empty)`);
      continue;
    }
    if (content.length > MARKDOWN_IMPORT_FILE_CHARS_MAX) {
      tooLong.push(source.path);
      continue;
    }
    const filename = importFilename(source.path, source.folder);
    documents.push(
      target === undefined ? { filename, content } : { filename, content, target },
    );
  }
  if (unreadable.length > 0) {
    writer.writeErr(`Skipped files that are empty or unreadable:\n  ${unreadable.join("\n  ")}`);
  }
  if (tooLong.length > 0) {
    writer.writeErr(
      `Skipped files over ${MARKDOWN_IMPORT_FILE_CHARS_MAX.toLocaleString("en-US")} characters, the most one file may hold:\n  ${tooLong.join("\n  ")}`,
    );
  }
  if (documents.length === 0) {
    failCommand("No readable, non-empty files to import.", writer);
  }
  return documents;
}

/**
 * The rows of several parse calls, with the duplicates and conflicts between
 * calls marked. A row keeps every mark its own call gave it. A row newly
 * marked a duplicate is skipped, and one newly marked a conflict waits for a
 * choice, as parse marks them.
 */
export function reconcileImportRows(
  records: readonly MarkdownImportRecord[],
): MarkdownImportRecord[] {
  const rows: ImportMatchRow[] = records.map((row) => ({
    lineage: row.lineage,
    kind: row.kind,
    effect: row.effect,
    statement: row.statement,
    path: null,
    duplicate: row.duplicate,
    conflict: row.conflict,
  }));
  markImportMatches(rows, []);
  return records.map((row, index): MarkdownImportRecord => {
    const marked = rows[index] as ImportMatchRow;
    if (marked.duplicate === row.duplicate && marked.conflict === row.conflict) return row;
    return {
      ...row,
      duplicate: marked.duplicate,
      conflict: marked.conflict,
      action: marked.conflict ? null : marked.duplicate ? "skip" : row.action,
    };
  });
}

/**
 * The policies of several parse calls, with the clashes between calls
 * marked. Parse checks the files of one call against each other, and a
 * policy file's name comes from its Markdown file's base name. So two files
 * sent in different calls, such as api/security.md and web/security.md, can
 * both become policy/security.cedar, or give two statements one @id. The
 * later of the two gets an issue and is marked skip, as parse marks a clash
 * inside one call. Commit would refuse the whole import for either clash.
 */
export function reconcileImportPolicies(
  policies: readonly MarkdownImportPolicy[],
): MarkdownImportPolicy[] {
  const paths = new Map<string, string>();
  const ids = new Map<string, string>();
  return policies.map((policy): MarkdownImportPolicy => {
    if (policy.action !== "add") return policy;
    const issues: MarkdownImportPolicy["issues"] = [];
    const other = paths.get(policy.path);
    if (other !== undefined) {
      issues.push({
        statement: null,
        id: null,
        line: null,
        message: `${other} in this import also becomes ${policy.path}. Rename one of the two files.`,
      });
    } else {
      for (const statement of policy.statements) {
        const holder = ids.get(statement.id);
        if (holder === undefined) continue;
        issues.push({
          statement: null,
          id: statement.id,
          line: statement.line,
          message: `@id ${statement.id} is also in ${holder} in this import. Give one of the two statements another @id.`,
        });
      }
    }
    if (issues.length > 0) {
      return { ...policy, issues: [...policy.issues, ...issues], action: "skip" };
    }
    paths.set(policy.path, policy.file);
    for (const statement of policy.statements) ids.set(statement.id, policy.path);
    return policy;
  });
}

/** Run one API call, and fail with its message when it throws. */
async function callApi<T>(call: () => Promise<T>, writer: CommandWriter): Promise<T> {
  try {
    return await call();
  } catch (err) {
    return failCommand(err instanceof Error ? err.message : String(err), writer);
  }
}

/** On stderr: each file parse skipped, and each file it could not read. */
function writeFileNotes(files: readonly MarkdownImportFile[], writer: CommandWriter): void {
  for (const file of files) {
    if (file.error) writer.writeErr(`  ${file.filename}: ${file.error}`);
    else if (file.target === "skip") writer.writeErr(`  Skipped ${file.filename}: ${file.reason}`);
  }
}

export interface MarkdownImportRun {
  /** Read Cedar policies too. Without it, the output and the commit carry no policies. */
  policies: boolean;
  /** Carry memory rows: print them, and store them on --yes. Without it, the output and the commit carry no memories. */
  memories?: boolean;
  /** Open the steering PR and store the memories. Without it, the import only prints the rows. */
  yes?: boolean;
  json?: boolean;
}

/**
 * Parse the documents in calls of 25, then print the rows, or commit them on
 * --yes.
 *
 * Each parse call compares only its own files, so one pass over every call's
 * record rows marks the duplicates and conflicts between calls. A row that
 * conflicts with a published record needs a person's choice, and the CLI has
 * no editor, so --yes leaves each one out and names it. An import that marks
 * more than 299 records and policy files add does not fit one steering PR,
 * so --yes refuses it. Memories count against no PR.
 */
export async function runMarkdownImport(
  documents: readonly MarkdownImportDocumentInput[],
  run: MarkdownImportRun,
  writer: CommandWriter,
): Promise<void> {
  const parsedRecords: MarkdownImportRecord[] = [];
  const parsedPolicies: MarkdownImportPolicy[] = [];
  const memories: MarkdownImportMemory[] = [];
  const files: MarkdownImportFile[] = [];
  for (let i = 0; i < documents.length; i += MARKDOWN_IMPORT_FILES_PER_CALL) {
    const batch = documents.slice(i, i + MARKDOWN_IMPORT_FILES_PER_CALL);
    const parsed = await callApi(() => parseMarkdownImport(batch), writer);
    parsedRecords.push(...parsed.records);
    parsedPolicies.push(...parsed.policies);
    if (run.memories) memories.push(...parsed.memories);
    files.push(...parsed.files);
  }
  const records = reconcileImportRows(parsedRecords);
  const policies = run.policies ? reconcileImportPolicies(parsedPolicies) : [];
  const count = markdownImportFileCount({ records, policies });
  const tooMany = markdownImportTooManyFiles(count);

  if (!run.yes) {
    if (run.json) {
      const pullRequestFiles = { count, max: STEERING_PR_MAX_FILES, message: tooMany };
      const output = {
        files,
        records,
        ...(run.policies ? { policies } : {}),
        ...(run.memories ? { memories } : {}),
        pullRequestFiles,
      };
      writer.write(JSON.stringify(output, null, 2));
      return;
    }
    const showRecords = records.length > 0 || (policies.length === 0 && memories.length === 0);
    const tables: string[] = [];
    if (showRecords) tables.push(formatImportRows(records));
    if (policies.length > 0) tables.push(formatImportPolicies(policies));
    if (memories.length > 0) tables.push(formatImportMemories(memories));
    writer.write(tables.join("\n\n"));
    writeFileNotes(files, writer);
    if (tooMany !== null) {
      writer.writeErr(`  ${tooMany}`);
    } else if (records.length + policies.length > 0) {
      writer.write(
        memories.length > 0
          ? "\nRun again with --yes to open the steering PR and store the memories."
          : "\nRun again with --yes to open the steering PR.",
      );
    } else if (memories.length > 0) {
      writer.write("\nRun again with --yes to store the memories.");
    }
    return;
  }

  if (!run.json) writeFileNotes(files, writer);
  for (const row of records) {
    if (row.action !== null) continue;
    writer.writeErr(
      `  Left out ${row.file}:${row.line} (${row.lineage}): it conflicts with ${row.conflict?.lineage ?? "a published record"}.`,
    );
  }
  for (const policy of policies) {
    const issue = policy.issues[0];
    if (policy.action !== "skip" || issue === undefined) continue;
    writer.writeErr(`  Left out ${policy.path} from ${policy.file}: ${issue.message}`);
  }
  const decided = records.map((row) =>
    row.action === null ? { ...row, action: "skip" as const } : row,
  );
  const adds =
    decided.some((row) => row.action === "add") ||
    policies.some((policy) => policy.action === "add") ||
    memories.some((row) => row.action === "add");
  if (!adds) {
    failCommand(
      memories.length > 0
        ? "No record, policy, or memory is marked add, so there is nothing to import."
        : run.policies
          ? "No record or policy is marked add, so there is no steering PR to open."
          : "No record is marked add, so there is no steering PR to open.",
      writer,
    );
  }
  if (tooMany !== null) failCommand(tooMany, writer);

  const result = await callApi(
    () =>
      commitMarkdownImport({
        records: decided,
        ...(run.policies ? { policies } : {}),
        ...(run.memories ? { memories } : {}),
      }),
    writer,
  );
  if (run.json) {
    writer.write(JSON.stringify(result, null, 2));
    return;
  }
  writer.write(formatImportPullRequest(result));
}
