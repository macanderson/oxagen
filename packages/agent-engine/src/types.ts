import type { ModelMessage } from "ai";
import type { AgentAi, MemoryProvider, TraceStore } from "./ports";

// ── Model tiers + usage accounting ──────────────────────────────────────────
// Shared by router, trace types, evaluator, planner, and fleet.

/** Cost/capability tier. Maps to a concrete gateway model via the model router. */
export type ModelTier = "fast" | "balanced" | "precise";

/** Token + cost accounting for one call or the whole fleet. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Estimated provider cost in USD, from the vendored rate card. */
  costUsd: number;
}

export function emptyUsage(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** Merge two UsageTotals additively. */
export function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

// ── Project context (injected by CLI; type lives here for engine portability) ─

/** Loaded project rules (CLAUDE.md / AGENTS.md / etc.), ready to inject. */
export interface ProjectContext {
  /** Concatenated rule text, ready to drop into the system prompt. */
  text: string;
  /** Source files that contributed, relative to cwd. */
  sources: string[];
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface Workspace {
  root: string;
  readFile(p: string, opts?: { offset?: number; limit?: number }): Promise<string>;
  writeFile(p: string, content: string): Promise<void>;
  editFile(p: string, oldString: string, newString: string): Promise<void>;
  list(dir?: string): Promise<string[]>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, opts?: { path?: string; glob?: string }): Promise<string[]>;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult>;
  diff(): Promise<string>;
}

export type CodingEvent =
  | { type: "text"; delta: string }
  | { type: "tool-call"; name: string; input: unknown }
  | { type: "tool-result"; name: string; output: string }
  | { type: "file-edit"; path: string; bytes: number }
  | { type: "command"; command: string; exitCode: number }
  | { type: "final-diff"; diff: string; changedFiles: string[] };

export interface CodeGraphProvider {
  query(
    operation: "search" | "file_symbols" | "dependents" | "imports",
    query: string,
    limit?: number,
  ): Promise<string>;
}

export interface RunCodingAgentOptions {
  workspace: Workspace;
  /** Injected AI port — BYOK/unmetered in the CLI, streamAgentReply (metered) on the platform. */
  ai: AgentAi;
  instruction: string;
  model?: string;
  system?: string;
  history?: ModelMessage[];
  maxSteps?: number;
  readOnly?: boolean;
  codeGraph?: CodeGraphProvider;
  memory?: MemoryProvider;
  trace?: TraceStore;
  signal?: AbortSignal;
  onEvent?: (e: CodingEvent) => void;
}

export interface RunCodingAgentResult {
  text: string;
  steps: number;
  diff: string;
  changedFiles: string[];
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  messages: ModelMessage[];
}
