/**
 * Project initialization workflow.
 *
 * On first turn in an uninitialized project (no .oxagen directory):
 * 1. Prompt user to initialize the project
 * 2. Create .oxagen/ structure
 * 3. Save settings
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
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

/** Initialize a project's `.oxagen` directory with a default `settings.json`. */
export async function initializeProject(
  opts: ProjectInitOptions,
): Promise<boolean> {
  const oxagenDir = resolve(opts.cwd, ".oxagen");

  // Skip if already initialized
  if (existsSync(oxagenDir)) {
    return false;
  }

  // Prompt user
  const approved = await opts.approver(
    `Initialize project? This will:\n` +
      `  · Create a .oxagen/ directory in this checkout\n` +
      `  · Write a default .oxagen/settings.json (model, permissions, hooks)\n` +
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

  console.log(`✓ Created .oxagen structure at ${oxagenDir}`);
  console.log(`  · Settings: ${settingsPath}`);

  return true;
}

/**
 * Confirm an action on the command line.
 *
 * Auto-approves ONLY in non-interactive/headless contexts (no TTY on stdin — CI,
 * piped input, or a spawned sub-process) where there is no human to ask; the
 * `process.stdin.isTTY` guard keeps unattended runs unblocked. On a real
 * terminal it asks the user with a readline prompt (the same primitive used by
 * other non-Ink commands, e.g. commands/auth.ts) and treats only an explicit
 * "y"/"yes" as approval.
 */
export async function promptConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return true;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${message} `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
