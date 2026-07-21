/**
 * Project initialization workflow.
 *
 * On first turn in an uninitialized project (no .oxagen directory):
 * 1. Prompt user to initialize the project
 * 2. Create .oxagen/ structure
 * 3. Ingest markdown files into the knowledge graph
 * 4. Save settings
 *
 * Step 3 uses the LIVE platform `graph.ingest` capability. It requires an
 * authenticated org+workspace context; when that is absent (logged out, or
 * BYOK-only with no platform scope) the local scaffold still succeeds and we
 * degrade GRACEFULLY — telling the user exactly what was skipped and how to
 * run it later, instead of falsely promising it will happen "on the next
 * agent run".
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { DEFAULT_CODING_MODEL } from "../agent/model-catalog.js";
import { resolveApiContext, apiPostOrThrow } from "../lib/api.js";

export interface ProjectInitOptions {
  cwd: string;
  approver: (prompt: string) => Promise<boolean>;
}

/** The `graph.ingest` contract caps input text at 100k chars. */
const MAX_INGEST_BYTES = 100_000;
/** Bound the number of docs ingested in one init so a huge repo can't stall it. */
const MAX_INGEST_FILES = 200;
/** Directories never worth walking for project docs. */
const MARKDOWN_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".oxagen",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".vercel",
]);

/** Check if a project is already initialized. */
export function isProjectInitialized(cwd: string): boolean {
  const oxagenDir = resolve(cwd, ".oxagen");
  return existsSync(oxagenDir);
}

/** Initialize a project's .oxagen directory and code graph. */
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

  console.log(`✓ Created .oxagen structure at ${oxagenDir}`);
  console.log(`  · Settings: ${settingsPath}`);

  // Kick off the live markdown ingest (or a graceful skip).
  await runInitialIndexing(opts.cwd);

  return true;
}

/**
 * Ingest project markdown into the workspace knowledge graph. This is a
 * platform capability: when there is no authenticated org+workspace context
 * we skip it with a clear, non-fatal message. Best-effort — a failure never
 * aborts init.
 */
async function runInitialIndexing(cwd: string): Promise<void> {
  const ctx = resolveApiContext();
  if (!ctx) {
    // Graceful degrade — say exactly what was skipped and how to run it later.
    console.log("  · Not signed in — skipped markdown ingest.");
    console.log("    Run `oxagen login` to ingest project docs later.");
    return;
  }

  // Markdown — ingest project docs into the knowledge graph via `graph.ingest`.
  const md = await ingestProjectMarkdown(cwd);
  if (md.found === 0) {
    console.log("  · No markdown files found to ingest.");
  } else if (md.ingested > 0) {
    console.log(
      `  · Ingested ${md.ingested}/${md.found} markdown file(s) into the knowledge graph` +
        (md.failed > 0 ? ` (${md.failed} failed).` : "."),
    );
  } else {
    console.log(
      `  · Markdown ingest skipped — all ${md.failed} file(s) failed. ` +
        "Check your connection and retry with the agent.",
    );
  }
}

/**
 * Ingest every project markdown file into the knowledge graph via `graph.ingest`.
 * Returns counts for a summary line. Per-file failures are isolated.
 */
async function ingestProjectMarkdown(
  cwd: string,
): Promise<{ found: number; ingested: number; failed: number }> {
  const files = findMarkdownFiles(cwd).slice(0, MAX_INGEST_FILES);
  let ingested = 0;
  let failed = 0;

  for (const abs of files) {
    let text: string;
    try {
      text = readFileSync(abs, "utf8").trim();
    } catch {
      failed++;
      continue;
    }
    // Empty docs have nothing to extract — skip without counting as a failure.
    if (!text) continue;
    const clipped =
      text.length > MAX_INGEST_BYTES ? text.slice(0, MAX_INGEST_BYTES) : text;
    try {
      await apiPostOrThrow("graph/ingest", {
        text: clipped,
        sourceUrl: relative(cwd, abs),
      });
      ingested++;
    } catch {
      failed++;
    }
  }

  return { found: files.length, ingested, failed };
}

/**
 * Locate project markdown files. Prefers `git ls-files` (respects .gitignore,
 * fast) and falls back to a bounded filesystem walk when `cwd` is not a git repo.
 */
function findMarkdownFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "*.md", "*.mdx"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const rels = out.split("\0").filter((r) => r.length > 0);
    if (rels.length > 0) {
      // De-dup (pathspecs can overlap) and resolve to absolute paths.
      return [...new Set(rels)].map((r) => resolve(cwd, r));
    }
  } catch {
    // Not a git repo / git unavailable — fall through to the walk.
  }
  const acc: string[] = [];
  walkMarkdown(cwd, acc);
  return acc;
}

/** Recursively collect `*.md`/`*.mdx` files, skipping noise dirs, up to the cap. */
function walkMarkdown(dir: string, acc: string[]): void {
  if (acc.length >= MAX_INGEST_FILES) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (acc.length >= MAX_INGEST_FILES) return;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (MARKDOWN_EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith("."))
        continue;
      walkMarkdown(full, acc);
    } else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) {
      acc.push(full);
    }
  }
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
