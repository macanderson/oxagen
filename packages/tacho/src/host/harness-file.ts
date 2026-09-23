/**
 * Writing into a file the user owns, and giving it back exactly.
 *
 * `enroll` edits five files that belong to someone else: Claude Code's
 * `settings.json`, Codex's `hooks.json`, Cursor's `hooks.json`, Stella's
 * `stella.toml` and Claude Desktop's MCP config. The writers that compute the new document are pure
 * and already keep every foreign entry. What they cannot do is put the file
 * itself back: a parsed-and-re-serialized document loses the user's
 * indentation and key order, a temp-file-and-rename replaces a symlink into a
 * dotfiles checkout with a regular file, the 0600 the token needs while
 * enrolled stays 0600 forever, and a file or directory enroll had to create
 * is left behind empty.
 *
 * So the first time Tacho touches a path it takes a receipt: whether the
 * file existed, its mode, a byte copy, and which parent directories it had to
 * make. `settle` is the other half, run by `unenroll` after the pure strip:
 *
 *   - the file did not exist and is blank again  -> delete it, and the
 *     directories made for it when they are empty;
 *   - the stripped document says the same thing the original did -> the
 *     original bytes go back, so the file is byte-identical;
 *   - the user edited it while enrolled -> their edit wins, the stripped
 *     document stays; only the mode is put back.
 *
 * Writes go through a symlink to the file it names, are atomic (sibling temp
 * file, fsync, rename) and refuse a file the user made read-only rather than
 * replace it underneath them.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { writeFileAtomic } from "./fs";

/** A harness file could not be read or written; `path` names it for the operator. */
export class HarnessFileError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = "HarnessFileError";
  }
}

interface Receipt {
  /** Whether the file was there before Tacho first wrote it. */
  existed: boolean;
  /** Its permission bits then (`mode & 0o777`); absent when it did not exist. */
  mode?: number;
  /** Byte copy of the original, under `backups/`; absent when it did not exist. */
  backup?: string;
  /** Parent directories Tacho created for it, outermost first. */
  created_dirs: string[];
  /**
   * SHA-256 of the bytes Tacho last wrote here, so `settle` can tell its own
   * leftovers from something the user typed. Absent on a receipt written
   * before this field existed, and on one taken by a `write` that then
   * failed; both fall back to the blankness test alone, which is what those
   * receipts have always had.
   */
  last_written?: string;
  /**
   * Whether that write said the document holds nothing but scaffolding this
   * writer itself added. Only a teardown passes it, and only when the strip
   * left nothing of the user's behind, so `settle` never reads a hook they
   * added while enrolled as our own residue.
   */
  vestigial?: boolean;
}

interface ReceiptsDocument {
  schema: "tacho.install-receipts.v1";
  files: Record<string, Receipt>;
}

export interface SettleOutcome {
  path: string;
  result: "restored" | "deleted" | "kept-user-edit" | "missing";
}

/** The file a path names once links are followed, even when it does not exist yet. */
function realTarget(path: string): string {
  let current = path;
  for (let hops = 0; hops < 16; hops += 1) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      return current;
    }
    if (!stat.isSymbolicLink()) return current;
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw new HarnessFileError(path, "too many levels of symbolic links");
}

function writeAtomic(path: string, data: string | Buffer, mode: number): void {
  writeFileAtomic(path, data, { mode });
}

/** Blank: nothing, whitespace, or a JSON document with nothing in it. */
/** SHA-256 of a file's text, as `settle` compares it against the receipt. */
function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isBlank(text: string): boolean {
  if (text.trim() === "") return true;
  try {
    return isDeepStrictEqual(JSON.parse(text), {});
  } catch {
    return false;
  }
}

/**
 * Two texts say the same thing: equal bytes, or equal JSON whatever the
 * layout, once empty containers are set aside.
 *
 * The empty containers are the strips' doing. `stripTachoSettings`,
 * `stripHookGroups` and `stripOxagenMcpServer` drop a `hooks`, `env` or
 * `mcpServers` they emptied, because one the merge created must not outlive
 * it. They cannot tell that from one the user already had empty: the merge
 * put Tacho's entries into it, so both look the same by the time of the
 * strip. A user whose settings held `"env": {}` then read as having edited
 * the file while enrolled, and got it back re-serialized instead of
 * byte-identical. An empty object or array says nothing a missing key does
 * not, so the comparison ignores them and the original bytes go back.
 */
function sameDocument(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return isDeepStrictEqual(
      withoutEmptyContainers(sortKeys(JSON.parse(a))),
      withoutEmptyContainers(sortKeys(JSON.parse(b))),
    );
  } catch {
    return false;
  }
}

/** The value with every member that is an empty object or array removed, innermost first. */
function withoutEmptyContainers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmptyContainers);
  if (typeof value !== "object" || value === null) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const pruned = withoutEmptyContainers(child);
    const empty =
      (Array.isArray(pruned) && pruned.length === 0) ||
      (pruned !== null &&
        typeof pruned === "object" &&
        !Array.isArray(pruned) &&
        Object.keys(pruned).length === 0);
    if (!empty) kept[key] = pruned;
  }
  return kept;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}

export class HarnessFiles {
  private readonly receiptsPath: string;
  private readonly backupsDir: string;

  /** `root` is `TachoPaths.root`; the receipts and backups live under it. */
  constructor(private readonly root: string) {
    this.receiptsPath = join(root, "install-receipts.json");
    this.backupsDir = join(root, "backups");
  }

  /** The file's text, or undefined when it does not exist. */
  readText(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new HarnessFileError(
        path,
        `cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
  }

  /** The file parsed as JSON; undefined when absent; a named error when malformed. */
  readJson(path: string): unknown {
    const text = this.readText(path);
    if (text === undefined) return undefined;
    // An empty file is what `touch` leaves; every harness reads it as no settings.
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new HarnessFileError(
        path,
        `is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it and run this again`,
      );
    }
  }

  /**
   * Whether `write` would be refused, without writing: the file, or the
   * nearest existing directory above it, is not writable by this user.
   */
  writeProblem(path: string): string | undefined {
    const target = realTarget(path);
    if (existsSync(target)) {
      if ((statSync(target).mode & 0o200) === 0)
        return "is read-only; Oxagen does not replace a file you have locked (chmod u+w it to allow the hooks)";
      return undefined;
    }
    let dir = dirname(target);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    if ((statSync(dir).mode & 0o200) === 0)
      return `cannot be created: ${dir} is read-only`;
    return undefined;
  }

  /**
   * Write `text`, taking a receipt the first time this path is touched.
   *
   * `vestigial` is the writer saying that what it is about to write holds
   * nothing but the scaffolding it had to add itself — Cursor's `version`
   * is the one instance — so `settle` may take the whole file back. It
   * defaults to false, and every ordinary write leaves it false, because a
   * teardown writes through here too: the stripped document is the bytes
   * Tacho last wrote, and a hook the user added while enrolled survives
   * inside it. Deleting on the digest alone would take that hook with the
   * file.
   */
  write(path: string, text: string, vestigial = false): void {
    const problem = this.writeProblem(path);
    if (problem !== undefined) throw new HarnessFileError(path, problem);
    const target = realTarget(path);
    const receipts = this.load();
    if (receipts.files[path] === undefined) {
      receipts.files[path] = this.takeReceipt(path, target);
      this.save(receipts);
    }
    for (const dir of receipts.files[path]?.created_dirs ?? []) {
      if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // 0600 while enrolled: every one of these files carries the loopback
    // bearer. `settle` puts the user's own mode back.
    writeAtomic(target, text, 0o600);
    const receipt = receipts.files[path];
    if (receipt !== undefined) {
      receipt.last_written = digestOf(text);
      receipt.vestigial = vestigial;
      this.save(receipts);
    }
  }

  /**
   * Give every file back (see the module comment). Safe to call with no
   * receipts, twice, or after a run that died half way.
   */
  settle(): SettleOutcome[] {
    const receipts = this.load();
    const outcomes: SettleOutcome[] = [];
    for (const [path, receipt] of Object.entries(receipts.files)) {
      outcomes.push({ path, result: this.settleOne(path, receipt) });
      delete receipts.files[path];
      this.save(receipts);
    }
    this.save(receipts);
    return outcomes;
  }

  private settleOne(path: string, receipt: Receipt): SettleOutcome["result"] {
    const target = realTarget(path);
    const backup =
      receipt.backup !== undefined && existsSync(receipt.backup)
        ? readFileSync(receipt.backup)
        : undefined;
    let result: SettleOutcome["result"];
    let current: string | undefined;
    try {
      current = readFileSync(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = undefined;
    }
    if (current === undefined) {
      result = "missing";
    } else if (!receipt.existed) {
      // A file Tacho created. Blank is the obvious case, but not the only
      // one: a strip leaves behind whatever scaffolding the merge had to add
      // to make the file valid in the first place, and Cursor's `version` is
      // exactly that — `mergeCursorHooks` writes it because the schema
      // requires a positive integer, and `stripCursorHooks` cannot drop it
      // without also emptying a file the user may have had. So a document of
      // nothing but our own scaffolding read as a user edit, and `.cursor`
      // and its `hooks.json` survived `--purge`.
      //
      // The writer says whether what it left is scaffolding and nothing
      // else, which is the one thing it knows and this seam does not, and
      // the digest then confirms nobody has touched the file since. Both are
      // needed. The digest alone is not enough because a teardown writes
      // through here too, so the stripped document — a hook the user added
      // while enrolled included — is by definition the bytes Tacho last
      // wrote. The flag alone is not enough because the file can still be
      // edited between the strip and the settle.
      const oursAlone =
        receipt.vestigial === true &&
        digestOf(current) === receipt.last_written;
      if (isBlank(current) || oursAlone) {
        unlinkSync(target);
        result = "deleted";
      } else {
        result = "kept-user-edit";
      }
    } else if (
      backup !== undefined &&
      sameDocument(current, backup.toString("utf8"))
    ) {
      writeAtomic(target, backup, receipt.mode ?? 0o644);
      result = "restored";
    } else {
      if (receipt.mode !== undefined) chmodSync(target, receipt.mode);
      result = "kept-user-edit";
    }
    if (receipt.backup !== undefined && existsSync(receipt.backup))
      unlinkSync(receipt.backup);
    for (const dir of [...receipt.created_dirs].reverse()) {
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir);
      } catch {
        // Already gone, or the user has put something in it: theirs to keep.
      }
    }
    return result;
  }

  private takeReceipt(path: string, target: string): Receipt {
    const created: string[] = [];
    let dir = dirname(target);
    while (!existsSync(dir) && dirname(dir) !== dir) {
      created.unshift(dir);
      dir = dirname(dir);
    }
    if (!existsSync(target)) return { existed: false, created_dirs: created };
    mkdirSync(this.backupsDir, { recursive: true, mode: 0o700 });
    const backup = join(
      this.backupsDir,
      `${createHash("sha256").update(path).digest("hex").slice(0, 24)}.orig`,
    );
    writeAtomic(backup, readFileSync(target), 0o600);
    return {
      existed: true,
      mode: statSync(target).mode & 0o777,
      backup,
      created_dirs: created,
    };
  }

  private load(): ReceiptsDocument {
    try {
      const parsed = JSON.parse(
        readFileSync(this.receiptsPath, "utf8"),
      ) as Partial<ReceiptsDocument>;
      if (typeof parsed.files === "object" && parsed.files !== null)
        return { schema: "tacho.install-receipts.v1", files: parsed.files };
    } catch {
      // Absent or unreadable: no receipts. A lost receipt degrades a restore
      // to "the stripped document stays", never to a lost user entry.
    }
    return { schema: "tacho.install-receipts.v1", files: {} };
  }

  private save(receipts: ReceiptsDocument): void {
    if (Object.keys(receipts.files).length === 0) {
      for (const path of [this.receiptsPath]) {
        if (existsSync(path)) unlinkSync(path);
      }
      try {
        if (readdirSync(this.backupsDir).length === 0)
          rmdirSync(this.backupsDir);
      } catch {
        // No backups directory.
      }
      return;
    }
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeAtomic(
      this.receiptsPath,
      `${JSON.stringify(receipts, null, 2)}\n`,
      0o600,
    );
  }
}
