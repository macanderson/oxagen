import { spawn, type ChildProcess } from "node:child_process";
import type { CommandNode } from "./command-tree.js";

export type FormValues = Record<string, string | boolean>;

// Build the argv tokens that follow the command path, from collected form values.
export function assembleArgv(node: CommandNode, values: FormValues): string[] {
  const tokens: string[] = [];

  for (const arg of node.args) {
    const v = values[`arg:${arg.name}`];
    if (typeof v === "string" && v.trim() !== "") {
      if (arg.variadic) tokens.push(...v.trim().split(/\s+/));
      else tokens.push(v);
    }
  }

  for (const opt of node.options) {
    const v = values[`opt:${opt.long}`];
    if (opt.isBoolean) {
      if (v === true) tokens.push(opt.long);
    } else if (typeof v === "string" && v.trim() !== "") {
      tokens.push(opt.long, v);
    }
  }

  return tokens;
}

// Execute the selected command as a child process so each run is isolated and
// repeat-safe. stdio is inherited so auth prompts and streaming output work.
export function runCommand(node: CommandNode, argv: string[]): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const entry = process.argv[1] ?? "";
    const child: ChildProcess = spawn(process.execPath, [entry, ...node.path, ...argv], { stdio: "inherit" });
    child.on("exit", (code: number | null) => resolve({ code: code ?? 0 }));
    child.on("error", () => resolve({ code: 1 }));
  });
}
