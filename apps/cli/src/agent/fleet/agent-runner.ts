/**
 * agent-runner.ts — the fleet's runner port, as a leaf module.
 *
 * The orchestrator consumes this interface; engine-runner.ts implements it.
 * Extracted from orchestrator.ts so the implementation can type-depend on the
 * port without importing the orchestrator — which value-imports the
 * implementation back as its default runner (that was a 2-file import cycle).
 */
import type { MemoryProvider, FileLockProvider } from "@oxagen/agent-engine";
import type { ProjectContext } from "../project-context.js";
import type { AgentDefinition } from "../../agents/types.js";

/** The runner interface the fleet depends on — backed by runTurn via createEngineRunner (injectable for tests). */
export type AgentRunner = (opts: {
  prompt: string;
  cwd: string;
  model?: string;
  projectContext?: ProjectContext;
  agent?: AgentDefinition;
  readOnly?: boolean;
  signal?: AbortSignal;
  memory?: MemoryProvider | null;
  /**
   * File-lock port injected per task (ADR-021 §5). When present, the engine's
   * write-path tools acquire on first write to a path so two tasks never
   * clobber the same file. `runTurn` mints its own per-turn holder identity, so
   * no lock context is threaded here. Omitted → unlocked (as before).
   */
  fileLock?: FileLockProvider | null;
  onText?: (delta: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}) => Promise<{
  text: string;
  steps: number;
  usage: { inputTokens?: number; outputTokens?: number };
}>;
