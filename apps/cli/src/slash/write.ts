import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializeArtifactToml } from "@oxagen/agent-artifacts";

export function scaffoldCommand(options: {
  name: string;
  cwd?: string;
  dir?: string;
}): { path: string; created: boolean } {
  const directory =
    options.dir ?? join(options.cwd ?? process.cwd(), ".oxagen", "commands");
  const path = join(directory, `${options.name}.toml`);
  const content = serializeArtifactToml({
    schema_version: 1,
    kind: "command",
    name: options.name,
    description: `Describe what /${options.name} does.`,
    argument_hint: "<arg>",
    prompt: `You are running /${options.name} with arguments: $ARGUMENTS`,
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
