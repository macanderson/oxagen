// The files a Markdown import reads (memory-collection spec, Bulk import; the
// mockup's md-import.js, `mdimTake` and `mdimDetect`): what a person dropped
// or chose, cut to the Markdown files, each read in this browser, and the
// target each file starts with. Nothing here sends a byte anywhere. The
// dialog sends a file's text only when the person asks for the review, and
// then in calls that each fit one server action.
//
// The default target follows the rule parse_markdown_import applies to a file
// sent with none (packages/handlers/src/markdown-import/parse.ts,
// `detectTarget`), so the Files step shows the target the server would pick.
// The dialog then sends that target explicitly. Two more rules are the
// dialog's own: a Claude Code memory file starts at Skip, because the Memories
// target arrives with memory collection (#4984), and a file the contract
// refuses (empty, too long, or a path past its limit) stays out with its
// reason rather than failing the whole call.
import {
  MARKDOWN_IMPORT_FILE_CHARS_MAX,
  MARKDOWN_IMPORT_FILES_MAX,
} from "@oxagen/oxagen/contracts/steering.markdown_import.shared";

/** The most Markdown files one import takes (memory-collection spec, Limits). */
export const IMPORT_FILES_MAX = 500;

/** The longest file name the contract takes, a folder path included. */
export const IMPORT_PATH_MAX = 256;

/**
 * The most bytes one parse call carries. A server action takes a 1 MB body by
 * default (next.config.ts sets no `bodySizeLimit`), and the request wraps
 * the files in its own encoding, so a call stays well under that.
 */
export const PARSE_CALL_BYTES_MAX = 800_000;

/** The targets a file can take. Memories is drawn, closed, until #4984. */
export type ImportTarget = "records" | "policies" | "skip";

/** Why a file starts at its target. */
export type TargetReason =
  | "prose"
  | "cedar"
  | "index"
  | "links"
  | "memory"
  | "empty"
  | "tooLarge"
  | "pathTooLong";

/** One Markdown file, read, with the target it has now. */
export type ImportFile = {
  /** The path inside the folder chosen, or the file's name. */
  path: string;
  content: string;
  lines: number;
  target: ImportTarget;
  /** Why the file started at its default target. */
  reason: TargetReason;
  /** True when the contract would refuse the file, so no target can send it. */
  locked: boolean;
};

/** A file the browser handed over, with the path it had inside what was chosen. */
export type PickedFile = {
  path: string;
  file: { readonly name: string; text(): Promise<string> };
};

/** What a pick or a drop read. */
export type ReadImport =
  | {
      ok: true;
      /** The folder chosen or dropped, when every file sat inside one. */
      folder: string | null;
      files: ImportFile[];
      /** Files left out because they are not Markdown. */
      ignored: number;
    }
  | { ok: false; reason: "none" | "tooMany" | "unreadable" };

const MARKDOWN = /\.(md|markdown)$/i;

/** The files of an `<input type="file">`: a folder input names each by its path inside the folder. */
export function pickedFromInput(
  list: ArrayLike<File> | Iterable<File>,
): PickedFile[] {
  return Array.from(list, (file) => ({
    path: file.webkitRelativePath || file.name,
    file,
  }));
}

/**
 * A dropped entry, as much of the browser's FileSystemEntry as the walk
 * reads. The browser's own entries fit these shapes.
 */
export interface DropEntry {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /** The entry's path from the drop, such as `/agents/api/retries.md`. */
  readonly fullPath: string;
}
export interface DropFileEntry extends DropEntry {
  file(ok: (file: File) => void, fail?: (error: DOMException) => void): void;
}
export interface DropDirectoryEntry extends DropEntry {
  createReader(): {
    readEntries(
      ok: (entries: DropEntry[]) => void,
      fail?: (error: DOMException) => void,
    ): void;
  };
}

function isFileEntry(entry: DropEntry): entry is DropFileEntry {
  return entry.isFile && "file" in entry;
}

function isDirectoryEntry(entry: DropEntry): entry is DropDirectoryEntry {
  return entry.isDirectory && "createReader" in entry;
}

/** Every file under a dropped entry, a folder walked to the bottom. */
async function walk(entry: DropEntry): Promise<PickedFile[]> {
  if (isFileEntry(entry)) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file(resolve, reject);
    });
    return [{ path: entry.fullPath, file }];
  }
  if (!isDirectoryEntry(entry)) return [];
  const reader = entry.createReader();
  const children: DropEntry[] = [];
  // A directory reader answers in pages, and an empty page is the end.
  for (;;) {
    const page = await new Promise<DropEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (page.length === 0) break;
    children.push(...page);
  }
  const nested = await Promise.all(children.map(walk));
  return nested.flat();
}

/** What a drop hands over: a DataTransfer's items and files. */
export type DropData = {
  items: Iterable<{ webkitGetAsEntry(): DropEntry | null }>;
  files: ArrayLike<File> | Iterable<File>;
};

/**
 * The files of a drop. A dropped folder arrives as an entry, walked for its
 * files, each keeping its path. A browser with no entries hands the files.
 * The entries are read before the first await, while the drop event lasts.
 */
export async function pickedFromDrop(data: DropData): Promise<PickedFile[]> {
  const entries: DropEntry[] = [];
  for (const item of data.items) {
    const entry = item.webkitGetAsEntry();
    if (entry !== null) entries.push(entry);
  }
  if (entries.length === 0) return pickedFromInput(data.files);
  const walked = await Promise.all(entries.map(walk));
  return walked.flat();
}

/** The number of lines a file holds, as an editor counts them. */
export function lineCount(content: string): number {
  return content === "" ? 0 : content.split("\n").length;
}

/** A fence opens on three or more backticks or tildes, indented at most three spaces (CommonMark). */
function fenceOpen(line: string): { ch: string; len: number; info: string } | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (m === null) return null;
  const run = m[1] ?? "";
  const rest = m[2] ?? "";
  if (run.startsWith("`") && rest.includes("`")) return null;
  return {
    ch: run.charAt(0),
    len: run.length,
    info: (rest.trim().split(/\s+/)[0] ?? "").toLowerCase(),
  };
}

/** A fence closes on a run of its own character, at least as long, with nothing after it. */
function fenceCloses(line: string, open: { ch: string; len: number }): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  const run = m?.[1] ?? "";
  return run.charAt(0) === open.ch && run.length >= open.len;
}

/**
 * True for a file that holds a fenced `cedar` block, or a `permit (` or
 * `forbid (` statement outside every fence. A Cedar example inside a fence of
 * another language is an example, not a policy.
 */
export function holdsCedar(content: string): boolean {
  let open: { ch: string; len: number; info: string } | null = null;
  for (const line of content.split("\n")) {
    if (open !== null) {
      if (fenceCloses(line, open)) open = null;
      continue;
    }
    open = fenceOpen(line);
    if (open !== null) {
      if (open.info === "cedar") return true;
      continue;
    }
    if (/^\s*(permit|forbid)\s*\(/.test(line)) return true;
  }
  return false;
}

/** README.md, index.md, and Claude Code's MEMORY.md describe the other files. */
function isIndexFile(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return /^(readme|index|memory)\.(md|markdown)$/i.test(name);
}

/** True when nothing is left once headings and links are gone (parse's own test). */
function onlyHeadingsAndLinks(content: string): boolean {
  const text = content
    .split("\n")
    .filter((line) => !/^\s{0,3}#/.test(line))
    .join("\n")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[*_>\-\s|]+/g, "");
  return text === "";
}

/**
 * Claude Code memory frontmatter: a name and a description, with the type at
 * the top level or under `metadata`, and no steering-record schema.
 */
export function isMemoryFile(content: string): boolean {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return false;
  const end = lines.indexOf("---", 1);
  if (end < 0) return false;
  const fields = new Set<string>();
  for (const line of lines.slice(1, end)) {
    const m = /^\s*(name|description|type|schema):/.exec(line);
    if (m?.[1] !== undefined) fields.add(m[1]);
  }
  return fields.has("name") && fields.has("description") && !fields.has("schema");
}

/** The target a file starts with, and why. */
export function detectTarget(
  path: string,
  content: string,
): { target: ImportTarget; reason: TargetReason; locked: boolean } {
  if (content.trim() === "")
    return { target: "skip", reason: "empty", locked: true };
  if (content.length > MARKDOWN_IMPORT_FILE_CHARS_MAX)
    return { target: "skip", reason: "tooLarge", locked: true };
  if (path.length > IMPORT_PATH_MAX)
    return { target: "skip", reason: "pathTooLong", locked: true };
  if (holdsCedar(content))
    return { target: "policies", reason: "cedar", locked: false };
  if (isIndexFile(path))
    return { target: "skip", reason: "index", locked: false };
  if (onlyHeadingsAndLinks(content))
    return { target: "skip", reason: "links", locked: false };
  if (isMemoryFile(content))
    return { target: "skip", reason: "memory", locked: false };
  return { target: "records", reason: "prose", locked: false };
}

/** Byte order: the same files in the same order every time. */
function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Read what a person chose. Only `.md` and `.markdown` files are read. When
 * every file sits inside one folder, that folder names the import and leaves
 * each file's path, so `agents/api/retries.md` in the folder `agents` is
 * `api/retries.md`. The files come back in path order.
 */
export async function readPicked(
  picked: readonly PickedFile[],
): Promise<ReadImport> {
  const markdown = picked.filter((p) => MARKDOWN.test(p.file.name));
  if (markdown.length === 0) return { ok: false, reason: "none" };
  if (markdown.length > IMPORT_FILES_MAX)
    return { ok: false, reason: "tooMany" };
  const parts = markdown.map((p) =>
    p.path.replace(/\\/g, "/").replace(/^\/+/, "").split("/"),
  );
  const first = parts[0]?.[0] ?? "";
  const nested = parts.every((p) => p.length > 1 && p[0] === first);
  let texts: string[];
  try {
    texts = await Promise.all(markdown.map((p) => p.file.text()));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const files = markdown
    .map((_, i): ImportFile => {
      const path = (nested ? (parts[i] ?? []).slice(1) : (parts[i] ?? [])).join(
        "/",
      );
      const content = texts[i] ?? "";
      return { path, content, lines: lineCount(content), ...detectTarget(path, content) };
    })
    .sort(byPath);
  return {
    ok: true,
    folder: nested ? first : null,
    files,
    ignored: picked.length - markdown.length,
  };
}

/** One document as parse_markdown_import takes it. */
export type ImportDocument = {
  filename: string;
  content: string;
  target: ImportTarget;
};

/** The documents a review sends: every file with a target other than Skip. */
export function documentsOf(files: readonly ImportFile[]): ImportDocument[] {
  return files
    .filter((f) => f.target !== "skip" && !f.locked)
    .map((f) => ({ filename: f.path, content: f.content, target: f.target }));
}

/** A document's size on the wire, near enough: its JSON in UTF-8. */
function bytesOf(document: ImportDocument): number {
  return new TextEncoder().encode(JSON.stringify(document)).length;
}

/**
 * The documents in parse calls: at most 25 files and PARSE_CALL_BYTES_MAX
 * bytes a call, in order. A document over the byte budget alone still goes,
 * in a call of its own: the contract caps a file at 100,000 characters, so it
 * stays under the body limit.
 */
export function parseBatches(
  documents: readonly ImportDocument[],
  limits: { files: number; bytes: number } = {
    files: MARKDOWN_IMPORT_FILES_MAX,
    bytes: PARSE_CALL_BYTES_MAX,
  },
): ImportDocument[][] {
  const batches: ImportDocument[][] = [];
  let batch: ImportDocument[] = [];
  let bytes = 0;
  for (const document of documents) {
    const size = bytesOf(document);
    if (
      batch.length > 0 &&
      (batch.length >= limits.files || bytes + size > limits.bytes)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(document);
    bytes += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** The key a parse is cached under: which files go, and with what target. */
export function parseKey(documents: readonly ImportDocument[]): string {
  return JSON.stringify(documents.map((d) => [d.filename, d.target]));
}
