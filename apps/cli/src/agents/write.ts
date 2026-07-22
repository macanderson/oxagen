import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";
import { DEFAULT_CODING_MODEL } from "../agent/model-catalog.js";

export function scaffoldAgent(options: {
  name: string;
  cwd?: string;
  dir?: string;
}): { path: string; created: boolean } {
  const directory =
    options.dir ?? join(options.cwd ?? process.cwd(), ".oxagen", "agents");
  const path = join(directory, `${options.name}.toml`);
  const content = serializeArtifactToml({
    schema_version: 1,
    kind: "agent",
    name: options.name,
    description: "Describe when this agent should be used.",
    model: DEFAULT_CODING_MODEL,
    developer_instructions: `You are the ${options.name} agent.\n\nDescribe the agent's role, focus, and behavior.`,
    tools: ["read_file", "list_dir", "glob", "grep", "bash"],
    skills: [],
    unresolved_tools: [],
  });
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { path, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      return { path, created: false };
    throw error;
  }
}
