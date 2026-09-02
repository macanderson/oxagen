import type { Workspace, CommandResult } from "@oxagen/agent-engine";
import type { GitHubClient } from "./types";

// ---------------------------------------------------------------------------
// Inline glob helper
// Cannot import from @oxagen/agent-engine internals (not part of public API).
// Algorithm identical to packages/agent-engine/src/internal/glob.ts.
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c as string)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXEC_UNSUPPORTED =
  "Command execution is not available in this API-backed GitHub workspace: it " +
  "edits files through the GitHub API with no real checkout, so builds, tests, " +
  "and git commands cannot run. Set SANDBOX_ENABLED=true (with a Modal driver) " +
  "so the platform coding agent runs in a durable sandbox with a cloned repo. " +
  "Until then, use read_file/write_file/edit_file/grep/glob to make changes; do " +
  "not run shell commands.";

const MAX_GREP_FILES = 200;
const MAX_GREP_HITS = 200;

// ---------------------------------------------------------------------------
// GitHubWorkspace
// ---------------------------------------------------------------------------

/**
 * A `Workspace` implementation backed by the GitHub Contents and Git Trees
 * APIs.  All reads are lazy-fetched and cached; all writes are staged in
 * memory and accessible via `diff()` / `changedFiles()`.
 *
 * Shell execution (`exec`) is not available — the workspace returns a
 * descriptive error result rather than throwing, so the agent loop can
 * surface it gracefully.
 */
export class GitHubWorkspace implements Workspace {
  readonly root = "/";

  private readonly client: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;
  private readonly ref: string;

  /**
   * Snapshot of each path as it existed on GitHub when first fetched.
   * `undefined` means the file did not exist (HTTP 404) — i.e. it is a
   * new file created by the agent.
   */
  private initial = new Map<string, string | undefined>();

  /**
   * Staged content for paths that have been written or edited.
   * Only paths that the agent has explicitly modified appear here.
   */
  private files = new Map<string, string>();

  /**
   * Tracks which paths have already been fetched from the GitHub API so we
   * never make a redundant network call for the same path.
   */
  private loadedPaths = new Set<string>();

  /** Cached file tree (lazy; populated on first getTree call). */
  private _tree: string[] | null = null;

  constructor(
    client: GitHubClient,
    opts: { owner: string; repo: string; ref: string },
  ) {
    this.client = client;
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.ref = opts.ref;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Fetch a file from GitHub, populate `initial`, and return the content. */
  private async fetchFromGitHub(p: string): Promise<string | null> {
    if (this.loadedPaths.has(p)) {
      // Already fetched — return the snapshotted original (no staged changes
      // since currentContent() handles the files-map check first).
      const orig = this.initial.get(p);
      return orig !== undefined ? orig : null;
    }
    const content = await this.client.getFileContent({
      owner: this.owner,
      repo: this.repo,
      path: p,
      ref: this.ref,
    });
    this.loadedPaths.add(p);
    // Record original: undefined for new files (404), string for existing.
    this.initial.set(p, content ?? undefined);
    return content;
  }

  /**
   * Return the current content for a path: staged content if it has been
   * written/edited, otherwise the GitHub content.
   */
  private async currentContent(p: string): Promise<string | null> {
    const staged = this.files.get(p);
    if (staged !== undefined) return staged;
    return this.fetchFromGitHub(p);
  }

  /** Return (and cache) the list of all blob paths in the repository tree. */
  private async getTree(): Promise<string[]> {
    if (this._tree !== null) return this._tree;
    this._tree = await this.client.getTree({
      owner: this.owner,
      repo: this.repo,
      ref: this.ref,
    });
    return this._tree;
  }

  // ---------------------------------------------------------------------------
  // Workspace — reads
  // ---------------------------------------------------------------------------

  async readFile(
    p: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<string> {
    const text = await this.currentContent(p);
    if (text === null) throw new Error(`ENOENT: ${p}`);
    if (opts?.offset == null && opts?.limit == null) return text;
    const lines = text.split("\n");
    // `offset` is 1-based. Clamp at 0 so a caller-supplied 0 (or a negative)
    // reads from the top of the file rather than wrapping to the last line,
    // which is what a bare `offset - 1` would hand to Array#slice.
    const start = opts?.offset != null ? Math.max(0, opts.offset - 1) : 0;
    const end = opts?.limit != null ? start + opts.limit : lines.length;
    return lines.slice(start, end).join("\n");
  }

  async list(dir?: string): Promise<string[]> {
    const tree = await this.getTree();
    // Normalise dir to a prefix string (empty string = repo root).
    const raw = dir === undefined || dir === "." || dir === "/" ? "" : dir;
    const prefix = raw.replace(/^\//, "").replace(/\/$/, "");
    const segPrefix = prefix.length > 0 ? prefix + "/" : "";
    const names = new Set<string>();
    for (const path of tree) {
      if (!path.startsWith(segPrefix)) continue;
      const rest = path.slice(segPrefix.length).split("/")[0];
      if (rest) names.add(rest);
    }
    return [...names].sort();
  }

  async glob(pattern: string): Promise<string[]> {
    const tree = await this.getTree();
    const re = globToRegExp(pattern);
    return tree.filter((p) => re.test(p)).sort();
  }

  async grep(
    pattern: string,
    opts?: { path?: string; glob?: string },
  ): Promise<string[]> {
    const re = new RegExp(pattern);
    const fileRe = opts?.glob
      ? globToRegExp(opts.glob.includes("/") ? opts.glob : `**/${opts.glob}`)
      : null;

    let candidates = await this.getTree();
    if (opts?.path) {
      const pathPrefix = opts.path;
      candidates = candidates.filter((p) => p.startsWith(pathPrefix));
    }
    if (fileRe) {
      candidates = candidates.filter((p) => fileRe.test(p));
    }
    // Cap how many files we fetch to avoid runaway API usage.
    candidates = candidates.slice(0, MAX_GREP_FILES);

    const hits: string[] = [];
    for (const path of candidates) {
      if (hits.length >= MAX_GREP_HITS) break;
      const text = await this.currentContent(path);
      if (text === null) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (re.test(line)) {
          hits.push(`${path}:${i + 1}:${line.slice(0, 200)}`);
          if (hits.length >= MAX_GREP_HITS) break;
        }
      }
    }
    return hits;
  }

  // ---------------------------------------------------------------------------
  // Workspace — writes (staged in memory)
  // ---------------------------------------------------------------------------

  async writeFile(p: string, content: string): Promise<void> {
    // Snapshot the original before staging so diff() / changedFiles() can
    // compare correctly.
    if (!this.initial.has(p)) {
      const existing = await this.client.getFileContent({
        owner: this.owner,
        repo: this.repo,
        path: p,
        ref: this.ref,
      });
      this.loadedPaths.add(p);
      this.initial.set(p, existing ?? undefined);
    }
    this.files.set(p, content);
  }

  async editFile(
    p: string,
    oldString: string,
    newString: string,
    opts?: { replaceAll?: boolean },
  ): Promise<number> {
    const text = await this.currentContent(p);
    if (text === null) throw new Error(`ENOENT: ${p}`);
    const count = oldString === "" ? 0 : text.split(oldString).length - 1;
    if (count === 0) throw new Error(`old_string not found in ${p}`);
    // `initial` is already recorded by this point: currentContent() either
    // fetched the path (fetchFromGitHub sets it) or read it from `files`, which
    // only the writeFile/editFile paths populate — and both set it first.
    if (opts?.replaceAll) {
      this.files.set(p, text.split(oldString).join(newString));
      return count;
    }
    if (count > 1)
      throw new Error(
        `old_string appears ${count} times in ${p}; must be unique`,
      );
    this.files.set(p, text.replace(oldString, newString));
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Workspace — exec (not supported)
  // ---------------------------------------------------------------------------

  async exec(
    _command: string,
    _opts?: { timeoutMs?: number },
  ): Promise<CommandResult> {
    return {
      exitCode: 1,
      stdout: "",
      stderr: EXEC_UNSUPPORTED,
      timedOut: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Workspace — diff / changed files
  // ---------------------------------------------------------------------------

  async diff(): Promise<string> {
    const out: string[] = [];
    for (const p of [...this.files.keys()].sort()) {
      const current = this.files.get(p);
      const orig = this.initial.get(p);
      if (current !== orig) {
        out.push(`--- a/${p}`, `+++ b/${p}`);
      }
    }
    return out.join("\n");
  }

  /**
   * Return every staged path whose current content differs from the GitHub
   * original (or that is a new file not present on GitHub).
   */
  changedFiles(): { path: string; content: string }[] {
    const result: { path: string; content: string }[] = [];
    for (const [path, content] of this.files) {
      const orig = this.initial.get(path);
      if (content !== orig) {
        result.push({ path, content });
      }
    }
    return result;
  }
}
