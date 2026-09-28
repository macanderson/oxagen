// notes.ts: the import notes for one schema, each message kept once per tool.
import type { ImportNote } from "../model/import-result";

export class Notes {
  readonly list: ImportNote[] = [];
  private readonly seen = new Set<string>();

  /** Adds a note unless the same tool already has the same message. */
  add(tool: string | undefined, message: string): void {
    const key = `${tool ?? ""}\n${message}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ tool, message });
  }
}
