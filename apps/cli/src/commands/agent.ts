/**
 * agent command — manage named agent definitions.
 *
 *   oxagen agent list            List available agents (name, description, source)
 *   oxagen agent show <name>     Show an agent's full definition + system prompt
 *   oxagen agent new <name>      Scaffold .oxagen/agents/<name>.md
 *
 * Run a single turn as an agent with `oxagen --agent <name> "<prompt>"`.
 *
 * Output discipline (ADR-023 §4): the list / definition / scaffold result is the
 * answer and goes to stdout via the writer (so it is REPL-bridge safe) — `--json`
 * emits one single-line JSON value (shape preserved: list → summary array, show →
 * the definition, new → `{name,path,created}`), pretty mode renders the human
 * view. A bad name exits 2 (usage) and an unknown agent exits 1, both as uniform
 * stderr error lines that never touch stdout.
 */
import {
  loadAgents,
  scaffoldAgent,
  type AgentDefinition,
  type LoadAgentsOptions,
} from "../agents/index.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export type AgentCmdCtx = Pick<LoadAgentsOptions, "cwd" | "userAgentsDir"> & {
  /** Legacy test seam; inline agent definitions are no longer loaded. */
  settingsOptions?: unknown;
  /** `--json`: emit the result as one machine-readable JSON value on stdout (ADR-023 §4). */
  json?: boolean;
};

/** Compact per-agent record for `agent list --json` (systemPrompt omitted — that's `show`). */
interface AgentSummary {
  name: string;
  description: string;
  source: string;
  tools: string[] | null;
  model: string | null;
}

function summarizeAgent(a: AgentDefinition): AgentSummary {
  return {
    name: a.name,
    description: a.description,
    source: a.source,
    tools: a.tools ?? null,
    model: a.model ?? null,
  };
}

export function agentList(
  ctx: AgentCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const agents = [...loadAgents(ctx).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  out.data(agents.map(summarizeAgent), () => prettyAgentList(agents));
}

export function agentShow(
  name: string,
  ctx: AgentCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const agent = loadAgents(ctx).get(name);
  if (!agent) {
    out.error(
      `Unknown agent "${name}". Run \`oxagen agent list\`.`,
      "not_found",
    );
    return;
  }
  out.data(agent, () => prettyAgent(agent));
}

export function agentNew(
  name: string,
  ctx: AgentCmdCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  if (!/^[A-Za-z0-9][\w-]*$/.test(name)) {
    // Malformed input → usage error (exit 2). Set before out.error so it wins.
    process.exitCode = 2;
    out.error(
      `Invalid agent name "${name}". Use letters, digits, dashes, underscores.`,
      "usage",
    );
    return;
  }
  const { path, created } = scaffoldAgent({ name, cwd: ctx.cwd });
  // The scaffold outcome IS the command's result → stdout via out.data; the
  // human "created/exists" line lives only in the pretty renderer.
  out.data({ name, path, created }, () =>
    created
      ? `✓ Created agent ${path}\n  Edit it, then run: oxagen --agent ${name} "<prompt>"`
      : `${path} already exists — left untouched.`,
  );
}

function prettyAgentList(agents: AgentDefinition[]): string {
  if (agents.length === 0) {
    return "No agents defined. Create one with `oxagen agent new <name>`.";
  }
  const lines: string[] = ["Agents:", ""];
  for (const a of agents) {
    const tools = a.tools ? a.tools.join(", ") : "(all tools)";
    lines.push(`  ${a.name}`);
    if (a.description) lines.push(`    ${a.description}`);
    lines.push(`    tools: ${tools}${a.model ? `  ·  model: ${a.model}` : ""}`);
  }
  return lines.join("\n");
}

function prettyAgent(agent: AgentDefinition): string {
  const lines: string[] = [`# ${agent.name}`];
  if (agent.description) lines.push(agent.description);
  lines.push("", `source: ${agent.source}`);
  lines.push(`tools:  ${agent.tools ? agent.tools.join(", ") : "(all tools)"}`);
  if (agent.model) lines.push(`model:  ${agent.model}`);
  lines.push("", "--- system prompt ---", "", agent.systemPrompt);
  return lines.join("\n");
}
