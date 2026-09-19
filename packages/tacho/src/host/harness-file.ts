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
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, data as never);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // openSync's mode is masked by the umask; the receipt's mode is exact.
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file is already gone.
    }
    throw error;
  }
}

/** Blank: nothing, whitespace, or a JSON document with nothing in it. */
function isBlank(text: string): boolean {
  if (text.trim() === "") return true;
  try {
    return isDeepStrictEqual(JSON.parse(text), {});
  } catch {
    return false;
  }
}

/** Two texts say the same thing: equal bytes, or equal JSON whatever the layout. */
function sameDocument(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return isDeepStrictEqual(sortKeys(JSON.parse(a)), sortKeys(JSON.parse(b)));
  } catch {
    return false;
  }
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

  /** Write `text`, taking a receipt the first time this path is touched. */
  write(path: string, text: string): void {
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
    } catch {
      current = undefined;
    }
    if (current === undefined) {
      result = "missing";
    } else if (!receipt.existed) {
      if (isBlank(current)) {
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
