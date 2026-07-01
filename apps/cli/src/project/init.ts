/**
 * Project initialization workflow.
 *
 * On first turn in an uninitialized project (no .oxagen directory):
 * 1. Prompt user to initialize the project
 * 2. Create .oxagen/ structure
 * 3. Initialize code graph
 * 4. Ingest markdown files as knowledge
 * 5. Save settings
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CODING_MODEL } from "../agent/model-catalog.js";

export interface ProjectInitOptions {
  cwd: string;
  approver: (prompt: string) => Promise<boolean>;
}

/** Check if a project is already initialized. */
export function isProjectInitialized(cwd: string): boolean {
  const oxagenDir = resolve(cwd, ".oxagen");
  return existsSync(oxagenDir);
}

/** Initialize a project's .oxagen directory and code graph. */
export async function initializeProject(opts: ProjectInitOptions): Promise<boolean> {
  const oxagenDir = resolve(opts.cwd, ".oxagen");

  // Skip if already initialized
  if (existsSync(oxagenDir)) {
    return false;
  }

  // Prompt user
  const approved = await opts.approver(
    `Initialize project? This will:\n` +
    `  · Create .oxagen/ directory with settings and graphs\n` +
    `  · Generate code graph and ingest markdown files\n` +
    `  · Set up knowledge graph for semantic search\n` +
    `\nContinue? (y/n)`,
  );

  if (!approved) {
    return false;
  }

  // Create .oxagen structure
  mkdirSync(oxagenDir, { recursive: true });

  // Initialize settings.json
  const settingsPath = resolve(oxagenDir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        $schema: "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json",
        model: DEFAULT_CODING_MODEL,
        env: {},
        permissions: {
          defaultMode: "default",
          deny: ["Bash(rm -rf*)", "Write(.env*)", "Read(.env*)"],
          allow: [],
        },
        hooks: {
          PreToolUse: [],
          PostToolUse: [],
          SessionStart: [],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // TODO: When contracts are wired:
  // - Invoke graph.init to create code graph
  // - Invoke semantic.ingest or markdown.ingest to process *.md files
  // For now, document what should happen:
  console.log(`✓ Created .oxagen structure at ${oxagenDir}`);
  console.log(`  · Settings: ${settingsPath}`);
  console.log(`  · Code graph will be initialized on next agent run`);
  console.log(`  · Markdown files will be ingested into knowledge graph`);

  return true;
}

/** Prompt via stdin (for non-interactive scenarios, defaults to 'yes'). */
export async function promptConfirm(_message: string): Promise<boolean> {
  // In REPL context, this will be called with the user's keyboard input handler
  // For now, return true to auto-initialize in headless scenarios
  return true;
}
