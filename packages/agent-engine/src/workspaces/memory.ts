import type { CommandResult, Workspace } from "../types";
import { globToRegExp } from "../internal/glob";
import { describeEditFailure } from "../tools";

export class MemoryWorkspace implements Workspace {
  readonly root: string;
  private files: Map<string, string>;
  private initial: Map<string, string>;
  private execHandler: (cmd: string) => CommandResult = () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  });

  constructor(files: Record<string, string> = {}, root = "/repo") {
    this.root = root;
    this.files = new Map(Object.entries(files));
    this.initial = new Map(Object.entries(files));
  }

  onExec(fn: (cmd: string) => CommandResult): void {
    this.execHandler = fn;
  }

  async readFile(
    p: string,
    opts?: { offset?: number; limit?: number },
  ): Promise<string> {
    const text = this.files.get(p);
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    if (opts?.offset == null && opts?.limit == null) return text;
    const lines = text.split("\n");
    const start = opts?.offset ? opts.offset - 1 : 0;
    const end = opts?.limit ? start + opts.limit : lines.length;
    return lines.slice(start, end).join("\n");
  }

  async writeFile(p: string, content: string): Promise<void> {
    this.files.set(p, content);
  }

  async editFile(
    p: string,
    oldString: string,
    newString: string,
    opts?: { replaceAll?: boolean },
  ): Promise<number> {
    const text = this.files.get(p);
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    const count = oldString === "" ? 0 : text.split(oldString).length - 1;
    if (opts?.replaceAll) {
      if (count === 0) {
        throw new Error(
          describeEditFailure(text, oldString) ??
            `old_string not found in ${p}`,
        );
      }
      this.files.set(p, text.split(oldString).join(newString));
      return count;
    }
    if (count !== 1) {
      throw new Error(
        describeEditFailure(text, oldString) ?? `old_string not found in ${p}`,
      );
    }
    this.files.set(p, text.replace(oldString, newString));
    return 1;
  }

  async list(dir = "."): Promise<string[]> {
    const prefix = dir === "." ? "" : dir.replace(/\/$/, "") + "/";
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length).split("/")[0];
      if (rest) names.add(rest);
    }
    return [...names].sort();
  }

  async glob(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.files.keys()].filter((p) => re.test(p)).sort();
  }

  async grep(
    pattern: string,
    opts?: { path?: string; glob?: string },
  ): Promise<string[]> {
    const re = new RegExp(pattern);
    const fileRe = opts?.glob
      ? globToRegExp(opts.glob.includes("/") ? opts.glob : `**/${opts.glob}`)
      : null;
    const hits: string[] = [];
    for (const [path, text] of this.files) {
      if (opts?.path && !path.startsWith(opts.path)) continue;
      if (fileRe && !fileRe.test(path)) continue;
      text.split("\n").forEach((line, i) => {
        if (re.test(line)) hits.push(`${path}:${i + 1}:${line.slice(0, 200)}`);
      });
    }
    return hits;
  }

  async exec(
    command: string,
    _opts?: { timeoutMs?: number },
  ): Promise<CommandResult> {
    return this.execHandler(command);
  }

  async diff(): Promise<string> {
    const out: string[] = [];
    const paths = new Set([...this.files.keys(), ...this.initial.keys()]);
    for (const p of [...paths].sort()) {
      if (this.files.get(p) !== this.initial.get(p)) {
        out.push(`--- a/${p}`, `+++ b/${p}`);
      }
    }
    return out.join("\n");
  }
}
