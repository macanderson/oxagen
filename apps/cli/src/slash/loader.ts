import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArtifactToml } from "@oxagen/agent-artifacts";
import type { SlashCommand } from "./types.js";

export interface LoadCommandsOptions {
  cwd?: string;
  userCommandsDir?: string;
}

function loadDirectory(
  directory: string,
  registry: Map<string, SlashCommand>,
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
    const source = join(directory, name);
    try {
      const artifact = parseArtifactToml(readFileSync(source, "utf8"));
      if (artifact.kind !== "command") continue;
      registry.set(artifact.name, {
        name: artifact.name,
        description: artifact.description,
        template: artifact.prompt,
        argumentHint: artifact.argument_hint,
        model: artifact.model,
        source,
      });
    } catch {
      // Invalid manifests are non-executable and isolated from valid siblings.
    }
  }
}

export function loadCommands(
  options: LoadCommandsOptions = {},
): Map<string, SlashCommand> {
  const cwd = options.cwd ?? process.cwd();
  const userDirectory =
    options.userCommandsDir ?? join(homedir(), ".config", "oxagen", "commands");
  const registry = new Map<string, SlashCommand>();
  loadDirectory(userDirectory, registry);
  loadDirectory(join(cwd, ".oxagen", "commands"), registry);
  return registry;
}
