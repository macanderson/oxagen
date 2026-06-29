/**
 * `MemoryProvider` adapter — bridges the CLI's local memory stores to the
 * engine port. The CLI has two memory sources (the engram-backed
 * {@link import("../memory.js").SessionMemory} and the JSON-lines fleet lessons
 * store); both expose `recall` + `remember`, so this adapter takes whichever the
 * caller wires in rather than hard-coding one.
 */
import type { MemoryProvider } from "@oxagen/agent-engine";

export interface CliMemoryOptions {
  /** Returns recalled context to prepend to the system prompt (empty when none). */
  recall?: () => Promise<string>;
  /** Records an episodic event. Fire-and-forget on the engine side. */
  remember?: (kind: string, content: unknown, status?: string) => void | Promise<void>;
  /** Releases any backing handles (DuckDB connection, file descriptors). */
  close?: () => Promise<void>;
}

export function createMemoryProvider(opts: CliMemoryOptions): MemoryProvider {
  return {
    recallContext: opts.recall ?? (() => Promise.resolve("")),
    remember: opts.remember ?? (() => {}),
    close: opts.close,
  };
}
