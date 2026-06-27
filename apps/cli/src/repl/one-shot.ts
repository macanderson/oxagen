/**
 * One-shot mode — run a single prompt through the local agent loop, stream the
 * response to stdout, exit.
 *
 * Usage:
 *   oxagen "fix the login bug"
 *   oxagen --readonly "explain how auth works"
 *   echo "explain this code" | oxagen
 *
 * The agent operates on the current working directory using local coding tools,
 * loads project rules (CLAUDE.md/AGENTS.md), and records the turn into Oxagen's
 * context engine. Model calls go through the Vercel AI Gateway.
 */
import { runTurn, MissingGatewayKeyError } from "../agent/pipeline.js";
import { loadProjectContext } from "../agent/project-context.js";
import { openSessionMemory } from "../agent/memory.js";
import { openFleetMemory } from "../agent/fleet/memory.js";
import { openTraceStore } from "../agent/trace-store.js";
import { appendVerboseLog } from "../agent/verbose-log.js";
import { formatVerboseSection } from "../agent/trace-format.js";
import { readConfig } from "../lib/config.js";

export interface OneShotOptions {
  readOnly?: boolean;
  model?: string;
  /** Skip the eval/enhance/judge pipeline and run the bare agent. */
  bare?: boolean;
  /** Capture + emit full per-turn telemetry (overrides config default). */
  verbose?: boolean;
}

export async function runOneShot(
  prompt: string,
  options: OneShotOptions = {},
): Promise<void> {
  const cwd = process.cwd();
  const projectContext = loadProjectContext(cwd);
  const memory = await openSessionMemory(cwd, `one-shot-${Date.now()}`);
  const fleetMemory = openFleetMemory(cwd);
  const traceStore = openTraceStore(cwd);
  const verbose = options.verbose ?? readConfig().verbose ?? false;

  try {
    let streamed = false;
    const result = await runTurn({
      prompt,
      cwd,
      projectContext,
      readOnly: options.readOnly,
      model: options.model,
      bare: options.bare,
      verbose,
      memory,
      fleetMemory,
      // Pipeline stage progress goes to stderr so stdout stays the clean answer.
      onStage: (stage) => {
        process.stderr.write(
          `  ${stage.label}${stage.detail ? ` · ${stage.detail}` : ""}\n`,
        );
      },
      onText: (delta) => {
        streamed = true;
        process.stdout.write(delta);
      },
      // Tool activity goes to stderr so stdout stays the clean final answer
      // (pipeable). e.g. `oxagen "..." > out.md` captures only the answer.
      onToolCall: (name, input) => {
        const summary =
          typeof input === "object" && input !== null
            ? JSON.stringify(input).slice(0, 120)
            : String(input);
        process.stderr.write(`  · ${name} ${summary}\n`);
      },
    });
    traceStore.record(result.trace);
    if (streamed) process.stdout.write("\n");
    // Verbose: append the structured record to the JSONL stream and print the
    // per-phase / per-model / cost breakdown to stderr (stdout stays the answer).
    if (verbose) {
      appendVerboseLog(cwd, result.trace);
      process.stderr.write(formatVerboseSection(result.trace).join("\n") + "\n");
    }
  } catch (err) {
    if (err instanceof MissingGatewayKeyError) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    process.exitCode = 1;
  } finally {
    await memory?.close();
  }
}

export async function runFromStdin(options: OneShotOptions = {}): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const prompt = Buffer.concat(chunks).toString("utf8").trim();
  if (!prompt) {
    process.stderr.write("Error: No input received on stdin.\n");
    process.exitCode = 1;
    return;
  }
  await runOneShot(prompt, options);
}
