// Split a stored unified diff into its files (ADR-292).
//
// The diff store keeps the forge's bytes as they came: one unified diff with
// a `diff --git a/<old> b/<new>` header before each file. A file's hunks are
// everything from its first `@@` line to the next header. A binary file has
// no hunks: GitHub writes `Binary files ... differ` or a `GIT binary patch`
// block instead, and the split says so rather than passing those bytes on.
//
// The split is pure, so the size caps and the path filter are tested without
// a store.

/** One file's part of a unified diff. */
export type DiffFilePart = {
  /** The path after the change; the old path for a removed file. */
  path: string;
  /** The path before a rename or copy; absent when the file kept its path. */
  previousPath?: string;
  /** The hunks from the first `@@` line; empty for a file with none. */
  hunks: string;
  binary: boolean;
};

const HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/** Unquote a path git wrote in C-style quotes, or answer it as written. */
function unquote(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}

/** The files a unified diff holds, in its order. */
export function splitUnifiedDiff(text: string): DiffFilePart[] {
  const out: DiffFilePart[] = [];
  const lines = text.split("\n");
  let current: {
    oldPath: string;
    newPath: string;
    deleted: boolean;
    renamed: boolean;
    body: string[];
    inHunks: boolean;
    binary: boolean;
  } | null = null;
  const flush = () => {
    if (current === null) return;
    const path = current.deleted ? current.oldPath : current.newPath;
    out.push({
      path,
      ...(current.renamed && current.oldPath !== current.newPath
        ? { previousPath: current.oldPath }
        : {}),
      hunks: current.body.join("\n"),
      binary: current.binary,
    });
  };
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header !== null) {
      flush();
      current = {
        oldPath: unquote(header[1] ?? ""),
        newPath: unquote(header[2] ?? ""),
        deleted: false,
        renamed: false,
        body: [],
        inHunks: false,
        binary: false,
      };
      continue;
    }
    if (current === null) continue;
    if (!current.inHunks) {
      if (line.startsWith("deleted file mode")) current.deleted = true;
      else if (line.startsWith("rename from ") || line.startsWith("copy from "))
        current.renamed = true;
      else if (
        line.startsWith("Binary files ") ||
        line.startsWith("GIT binary patch")
      )
        current.binary = true;
      else if (line.startsWith("+++ b/"))
        current.newPath = unquote(line.slice("+++ b/".length));
      else if (line.startsWith("--- a/"))
        current.oldPath = unquote(line.slice("--- a/".length));
      if (line.startsWith("@@")) {
        current.inHunks = true;
        current.body.push(line);
      }
      continue;
    }
    current.body.push(line);
  }
  flush();
  // A trailing newline leaves an empty last line on the last file.
  const last = out.at(-1);
  if (last !== undefined && last.hunks.endsWith("\n"))
    last.hunks = last.hunks.slice(0, -1);
  return out;
}

/** A file's hunks cut to a budget, and whether they were cut. */
export function capHunks(
  hunks: string,
  max: number,
): { text: string; truncated: boolean } {
  if (hunks.length <= max) return { text: hunks, truncated: false };
  // Cut at a line end so the last line shown is whole.
  const cut = hunks.lastIndexOf("\n", max);
  return { text: hunks.slice(0, cut > 0 ? cut : max), truncated: true };
}
