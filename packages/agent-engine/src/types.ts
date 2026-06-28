import type { ModelMessage } from "ai";

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
  instruction: string;
  model?: string;
  system?: string;
  history?: ModelMessage[];
  maxSteps?: number;
  readOnly?: boolean;
  codeGraph?: CodeGraphProvider;
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
