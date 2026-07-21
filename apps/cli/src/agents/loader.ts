import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArtifactToml } from "@oxagen/agent-artifacts";
import type { AgentDefinition } from "./types.js";

export interface LoadAgentsOptions {
  cwd?: string;
  userAgentsDir?: string;
  onDiagnostic?: (diagnostic: {
    code: "invalid_artifact" | "artifact_needs_review";
    path: string;
    message: string;
  }) => void;
}

function loadDirectory(
  directory: string,
  registry: Map<string, AgentDefinition>,
  onDiagnostic: LoadAgentsOptions["onDiagnostic"],
): void {
  if (!existsSync(directory)) return;
  let names: string[];
  try {
    names = readdirSync(directory)
      .filter((name) => name.endsWith(".toml"))
      .sort();
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(directory, name);
    try {
      const artifact = parseArtifactToml(readFileSync(path, "utf8"));
      if (artifact.kind !== "agent") continue;
      if (artifact.unresolved_tools.length > 0) {
        onDiagnostic?.({
          code: "artifact_needs_review",
          path,
          message: `unresolved tools: ${artifact.unresolved_tools.join(", ")}`,
        });
        continue;
      }
      registry.set(artifact.name, {
        name: artifact.name,
        description: artifact.description,
        systemPrompt: artifact.developer_instructions,
        tools: artifact.tools.length > 0 ? artifact.tools : undefined,
        model: artifact.model,
        skills: artifact.skills.length > 0 ? artifact.skills : undefined,
        source: path,
      });
    } catch (error) {
      onDiagnostic?.({
        code: "invalid_artifact",
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function loadAgents(
  options: LoadAgentsOptions = {},
): Map<string, AgentDefinition> {
  const cwd = options.cwd ?? process.cwd();
  const userDirectory =
    options.userAgentsDir ?? join(homedir(), ".config", "oxagen", "agents");
  const registry = new Map<string, AgentDefinition>();
  loadDirectory(userDirectory, registry, options.onDiagnostic);
  loadDirectory(join(cwd, ".oxagen", "agents"), registry, options.onDiagnostic);
  return registry;
}

export function getAgent(
  name: string,
  options: LoadAgentsOptions = {},
): AgentDefinition | null {
  return loadAgents(options).get(name) ?? null;
}
