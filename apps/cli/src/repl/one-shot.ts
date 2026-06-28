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
import { runAgent } from "../agent/loop.js";
import { loadProjectContext } from "../agent/project-context.js";
import { openSessionMemory } from "../agent/memory.js";
import { openFleetMemory } from "../agent/fleet/memory.js";
import { openTraceStore } from "../agent/trace-store.js";
import { getAgent } from "../agents/loader.js";
import { appendVerboseLog } from "../agent/verbose-log.js";
import { formatVerboseSection } from "../agent/trace-format.js";
import { readConfig } from "../lib/config.js";
import { PermissionBroker, type PermissionMode } from "../agent/permissions.js";
import { formatToolCallWithSpacing } from "../agent/tool-formatter.js";

export interface OneShotOptions {
  readOnly?: boolean;
  model?: string;
  /**
   * Permission posture. One-shot is non-interactive, so there is no approver:
   * `ask` fails closed (mutations are denied), `acceptEdits` auto-allows file
   * edits, `bypass` allows everything. When unset, the run is ungated (the
   * historical scripted behavior).
   */
  mode?: PermissionMode;
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

  // Non-interactive: build a broker only when a mode is requested. With no
  // approver, `ask` denies mutations (fail closed); acceptEdits/bypass enable
  // scripted edits. The model-router never under-spends on safety regardless.
  const broker =
    options.mode && options.mode !== "readonly"
      ? new PermissionBroker({ mode: options.mode, cwd })
      : undefined;
  const readOnly = options.readOnly || options.mode === "readonly";

  try {
    let streamed = false;
    const result = await runTurn({
      prompt,
      cwd,
      projectContext,
      readOnly,
      broker,
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
        process.stderr.write(formatToolCallWithSpacing(name, input));
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

/**
 * Run a single prompt as a named agent (its system prompt, tool allowlist, and
 * model). Bypasses the eval/enhance/judge pipeline — the agent's own prompt is
 * authoritative. Streams the answer to stdout; tool activity to stderr.
 */
export async function runAgentOneShot(
  prompt: string,
  agentName: string,
  options: OneShotOptions = {},
): Promise<void> {
  const cwd = process.cwd();
  const agent = getAgent(agentName, { cwd });
  if (!agent) {
    process.stderr.write(`Error: unknown agent "${agentName}". Run \`oxagen agent list\`.\n`);
    process.exitCode = 1;
    return;
  }
  const projectContext = loadProjectContext(cwd);
  const memory = await openSessionMemory(cwd, `agent-${agentName}-${Date.now()}`);
  try {
    let streamed = false;
    await runAgent({
      prompt,
      cwd,
      agent,
      readOnly: options.readOnly,
      model: options.model,
      projectContext,
      memory,
      onText: (delta) => {
        streamed = true;
        process.stdout.write(delta);
      },
      onToolCall: (name, input) => {
        const summary =
          typeof input === "object" && input !== null
            ? JSON.stringify(input).slice(0, 120)
            : String(input);
        process.stderr.write(`  · ${name} ${summary}\n`);
      },
      onToolBlocked: (name, reason) => process.stderr.write(`  ⛔ ${name}: ${reason}\n`),
    });
    if (streamed) process.stdout.write("\n");
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
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
