// The file an agent with no committed definition starts from: the keys
// commit_agent_definition refuses a file without, and the name and
// description the identity records. The Configuration form, the source
// editor and the Run page's Model fit change all open on it, so the seeds
// cannot disagree.
import { AGENT_DEFINITION_SCHEMA } from "@oxagen/oxagen/contracts/agent.definition.commit";

/** The identity fields the seed writes, as the agent registry records them. */
type SeedIdentity = {
  slug: string;
  name: string;
  description: string | null;
};

export function definitionSeed(identity: SeedIdentity): string {
  const lines = [
    `schema = ${JSON.stringify(AGENT_DEFINITION_SCHEMA)}`,
    `slug = ${JSON.stringify(identity.slug)}`,
    `name = ${JSON.stringify(identity.name)}`,
  ];
  if (identity.description !== null)
    lines.push(`description = ${JSON.stringify(identity.description)}`);
  return `${lines.join("\n")}\n`;
}
