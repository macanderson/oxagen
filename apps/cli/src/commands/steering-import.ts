/**
 * `oxagen steering import <paths...> [--as records|policies|memories] [--yes] [--json]`:
 * read Markdown files, and every .md, .markdown, and .mdx file under a
 * folder, into steering records, Cedar policies, or memories.
 *
 * Without --as, each file takes the target its text implies, which
 * parse_markdown_import decides: a file with a fenced `cedar` block becomes
 * policies, a README or index file is skipped, and the rest become records.
 * --as sets one target for every file. --as memories splits every file into
 * statements stored as waiting memories.
 *
 * A bare call previews the rows and writes nothing. --yes commits every row
 * marked add (commit_markdown_import): one steering PR holds the records and
 * policies, and the memories are stored as waiting memories with capture
 * `import`. lib/markdown-import holds the batching, the matching between
 * calls, the preview, and the commit, which `oxagen memory import` shares.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { extname, join } from "node:path";
import {
  failCommand,
  stdoutWriter,
  type CommandWriter,
} from "../lib/capture-writer.js";
import {
  readImportDocuments,
  runMarkdownImport,
  type ImportSource,
} from "../lib/markdown-import.js";

/**
 * The capabilities `oxagen steering import` calls, by their registered names:
 * parse_markdown_import, then commit_markdown_import on --yes.
 */
export const STEERING_IMPORT_CAPABILITIES = [
  "parse_markdown_import",
  "commit_markdown_import",
] as const;

/** The extensions a folder walk takes. A file named on the command line is taken as given. */
export const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".markdown", ".mdx"]);

/** The targets --as takes. */
export type SteeringImportTarget = "records" | "policies" | "memories";

const TARGETS: readonly SteeringImportTarget[] = ["records", "policies", "memories"];

/** What a walk of the command line's paths found. */
export interface MarkdownWalk {
  /** The files to read, in the order the paths were given and sorted by name inside each folder. */
  sources: ImportSource[];
  /** Paths that do not exist, and folders that could not be listed. */
  unreadable: string[];
}

/** Name order. Two entries of one folder never share a name. */
function byName(a: Dirent, b: Dirent): number {
  return a.name < b.name ? -1 : 1;
}

/**
 * The files the command line names. A file is taken as given. A folder is
 * searched for .md, .markdown, and .mdx files. The search skips every folder
 * whose name starts with a dot and every node_modules folder, and it never
 * follows a link into a folder, so it cannot loop. A folder named on the
 * command line is searched even when its name starts with a dot. A file
 * reached twice, by two paths or through a link, is read once.
 */
export async function findMarkdownFiles(paths: readonly string[]): Promise<MarkdownWalk> {
  const sources: ImportSource[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();

  const take = async (path: string, folder?: string): Promise<void> => {
    let real = path;
    try {
      real = await realpath(path);
    } catch {
      // A broken link keeps its own path, and reading it reports it.
    }
    if (seen.has(real)) return;
    seen.add(real);
    sources.push(folder === undefined ? { path } : { path, folder });
  };

  const walk = async (dir: string, folder: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      unreadable.push(dir);
      return;
    }
    entries.sort(byName);
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        await walk(path, folder);
      } else if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        MARKDOWN_EXTENSIONS.has(extname(entry.name).toLowerCase())
      ) {
        await take(path, folder);
      }
    }
  };

  for (const path of paths) {
    let isFolder: boolean;
    try {
      isFolder = (await stat(path)).isDirectory();
    } catch {
      unreadable.push(path);
      continue;
    }
    if (isFolder) await walk(path, path);
    else await take(path);
  }
  return { sources, unreadable };
}

function parseTarget(
  value: string | undefined,
  writer: CommandWriter,
): SteeringImportTarget | undefined {
  if (value === undefined) return undefined;
  const target = TARGETS.find((t) => t === value.toLowerCase());
  if (target !== undefined) return target;
  failCommand(`Invalid --as "${value}". Use records, policies, or memories.`, writer);
}

export interface SteeringImportCliOptions {
  /** records, policies, or memories for every file. Without it, each file takes the target its text implies. */
  as?: string;
  /** Open the steering PR and store the memories. Without it, the command only previews the rows. */
  yes?: boolean;
  json?: boolean;
}

/**
 * `oxagen steering import <paths...>`: find the Markdown files, read them,
 * and run the import. See the file header for the targets and --yes.
 */
export async function handleSteeringImport(
  paths: string[],
  opts: SteeringImportCliOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  if (paths.length === 0) {
    failCommand(
      "Nothing to import. Pass Markdown files or folders, such as `oxagen steering import docs`.",
      writer,
    );
  }
  const target = parseTarget(opts.as, writer);
  const walk = await findMarkdownFiles(paths);
  if (walk.unreadable.length > 0) {
    writer.writeErr(
      `Skipped paths that do not exist or cannot be read:\n  ${walk.unreadable.join("\n  ")}`,
    );
  }
  if (walk.sources.length === 0) {
    failCommand(
      `Found no .md, .markdown, or .mdx file in ${paths.join(", ")}. Pass a Markdown file, or a folder that holds one.`,
      writer,
    );
  }
  const documents = await readImportDocuments(walk.sources, target, writer);
  await runMarkdownImport(
    documents,
    { policies: true, memories: true, yes: opts.yes, json: opts.json },
    writer,
  );
}
