// The file an agent with no committed definition starts from: the keys
// commit_agent_definition refuses a file without, and the name and
// description the identity records. Both the Configuration form and the
// source editor open on it, so the two seeds cannot disagree.
import { AGENT_DEFINITION_SCHEMA } from "@oxagen/oxagen/contracts/agent.definition.commit";
import type { AgentDetail } from "@/data/contracts/agents";

export function definitionSeed(identity: AgentDetail["identity"]): string {
  const lines = [
    `schema = ${JSON.stringify(AGENT_DEFINITION_SCHEMA)}`,
    `slug = ${JSON.stringify(identity.slug)}`,
    `name = ${JSON.stringify(identity.name)}`,
  ];
  if (identity.description !== null)
    lines.push(`description = ${JSON.stringify(identity.description)}`);
  return `${lines.join("\n")}\n`;
}
