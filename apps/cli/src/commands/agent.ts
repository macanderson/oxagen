/**
 * agent command — manage named agent definitions.
 *
 *   oxagen agent list            List available agents (name, description, source)
 *   oxagen agent show <name>     Show an agent's full definition + system prompt
 *   oxagen agent new <name>      Scaffold .oxagen/agents/<name>.md
 *
 * Run a single turn as an agent with `oxagen --agent <name> "<prompt>"`.
 */
import { loadAgents, scaffoldAgent, type LoadAgentsOptions } from "../agents/index.js";

export type AgentCmdCtx = Pick<LoadAgentsOptions, "cwd" | "userAgentsDir" | "settingsOptions">;

export function agentList(ctx: AgentCmdCtx = {}): void {
  const agents = [...loadAgents(ctx).values()].sort((a, b) => a.name.localeCompare(b.name));
  if (agents.length === 0) {
    console.log("No agents defined. Create one with `oxagen agent new <name>`.");
    return;
  }
  console.log("Agents:\n");
  for (const a of agents) {
    const tools = a.tools ? a.tools.join(", ") : "(all tools)";
    console.log(`  ${a.name}`);
    if (a.description) console.log(`    ${a.description}`);
    console.log(`    tools: ${tools}${a.model ? `  ·  model: ${a.model}` : ""}`);
  }
}

export function agentShow(name: string, ctx: AgentCmdCtx = {}): void {
  const agent = loadAgents(ctx).get(name);
  if (!agent) {
    console.error(`Unknown agent "${name}". Run \`oxagen agent list\`.`);
    process.exitCode = 1;
    return;
  }
  console.log(`# ${agent.name}`);
  if (agent.description) console.log(agent.description);
  console.log(`\nsource: ${agent.source}`);
  console.log(`tools:  ${agent.tools ? agent.tools.join(", ") : "(all tools)"}`);
  if (agent.model) console.log(`model:  ${agent.model}`);
  console.log("\n--- system prompt ---\n");
  console.log(agent.systemPrompt);
}

export function agentNew(name: string, ctx: AgentCmdCtx = {}): void {
  if (!/^[A-Za-z0-9][\w-]*$/.test(name)) {
    console.error(`Invalid agent name "${name}". Use letters, digits, dashes, underscores.`);
    process.exitCode = 1;
    return;
  }
  const { path, created } = scaffoldAgent({ name, cwd: ctx.cwd });
  if (created) {
    console.log(`✓ Created agent ${path}`);
    console.log(`  Edit it, then run: oxagen --agent ${name} "<prompt>"`);
  } else {
    console.log(`${path} already exists — left untouched.`);
  }
}
