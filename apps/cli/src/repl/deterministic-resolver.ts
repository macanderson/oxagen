/**
 * Deterministic turn resolver — determinism before intelligence.
 *
 * The CLI's philosophy is to assess the desired capability and resolve it
 * deterministically whenever possible: deterministic is fast, cheap, and
 * reproducible. This module is the seam where a REPL submission that maps to a
 * fully-determined artifact is resolved in-process — no planner, no engine
 * loop, no model call, no tokens. It mirrors the existing CLI-catalog inline
 * short-circuit in interactive.tsx (safe commands run inline instead of
 * dispatching a turn).
 *
 * The matcher is deliberately conservative: it classifies EVERY word of the
 * submission (intent verb / filler / separator / target / artifact reference)
 * and bails to the normal model pipeline if even one word is unaccounted for.
 * "create a .gitignore optimized for mac osx and python" resolves; "create a
 * .gitignore for python but keep the build dir" has an unclassifiable clause
 * and falls through. A wrong deterministic answer is worse than a slow one —
 * when in doubt, use intelligence.
 *
 * v1 scope: .gitignore composition from curated templates (the canonical
 * "solved deterministically" artifact). The resolver interface is
 * artifact-agnostic so future recipes (LICENSE, .editorconfig, CI skeletons)
 * plug in as additional matchers.
 */
import { composeGitignore, GITIGNORE_SECTIONS } from "./gitignore-templates.js";

export interface DeterministicResolution {
  /** Workspace-relative path of the file to create. */
  path: string;
  /** Full file content to write. */
  content: string;
  /**
   * One-line summary for the transcript and conversation history — written so
   * the model understands, on a later turn, exactly what was created and how.
   */
  summary: string;
  /** Canonical target keys that matched (telemetry + tests). */
  targets: string[];
}

export interface ResolverContext {
  /** Returns true when `relPath` already exists in the workspace. */
  fileExists: (relPath: string) => boolean;
}

/** Alias → canonical section key. Multi-word aliases are normalized first. */
const TARGET_ALIASES: Record<string, string> = {
  mac: "macos",
  macos: "macos",
  macosx: "macos",
  osx: "macos",
  darwin: "macos",
  apple: "macos",
  windows: "windows",
  win: "windows",
  linux: "linux",
  unix: "linux",
  ubuntu: "linux",
  debian: "linux",
  python: "python",
  python3: "python",
  py: "python",
  node: "node",
  nodejs: "node",
  javascript: "node",
  js: "node",
  typescript: "node",
  ts: "node",
  react: "node",
  nextjs: "node",
  vite: "node",
  npm: "node",
  pnpm: "node",
  yarn: "node",
  go: "go",
  golang: "go",
  rust: "rust",
  cargo: "rust",
  java: "java",
  kotlin: "java",
  jetbrains: "jetbrains",
  intellij: "jetbrains",
  idea: "jetbrains",
  pycharm: "jetbrains",
  webstorm: "jetbrains",
  phpstorm: "jetbrains",
  goland: "jetbrains",
  rider: "jetbrains",
  clion: "jetbrains",
  vscode: "vscode",
};

/**
 * Multi-word target spellings collapsed to a single alias token before word
 * classification ("mac os x" → "macos", "vs code" → "vscode").
 */
const MULTIWORD_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/\bmac\s*os\s*x\b/g, "macos"],
  [/\bos\s*x\b/g, "osx"],
  [/\bmac\s*os\b/g, "macos"],
  [/\bnext\.js\b/g, "nextjs"],
  [/\bnode\.js\b/g, "nodejs"],
  [/\bvs\s*code\b/g, "vscode"],
  [/\bvisual\s+studio\s+code\b/g, "vscode"],
];

/** Leading intent verbs that mean "produce this artifact". */
const INTENT_VERBS = new Set([
  "create",
  "add",
  "generate",
  "make",
  "write",
  "init",
  "initialize",
  "scaffold",
]);

/**
 * Words that carry no meaning for template selection and are safe to skip.
 * Anything NOT in this set, the aliases, the verbs, or the separators causes a
 * bail — this list is the entire tolerated vocabulary, keep it boring.
 */
const FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "please",
  "pls",
  "can",
  "could",
  "would",
  "you",
  "me",
  "us",
  "give",
  "new",
  "for",
  "to",
  "on",
  "of",
  "my",
  "our",
  "this",
  "that",
  "file",
  "files",
  "project",
  "projects",
  "repo",
  "repository",
  "app",
  "application",
  "development",
  "dev",
  "environment",
  "setup",
  "stack",
  "work",
  "working",
  "use",
  "using",
  "based",
  "optimized",
  "optimised",
  "tailored",
  "suitable",
  "suited",
  "machine",
  "laptop",
  "computer",
  "os",
  "operating",
  "system",
  "targeting",
  "covering",
  "standard",
  "typical",
  "good",
  "proper",
  "sensible",
  "up",
]);

/** Tokens that separate targets in an enumeration. */
const SEPARATOR_WORDS = new Set(["and", "plus", "with", "also", "both", "or"]);

/** References to the artifact itself. */
const GITIGNORE_WORDS = new Set(["gitignore", ".gitignore"]);

/**
 * Try to resolve `submission` as a deterministic .gitignore creation.
 * Returns null on ANY doubt — unknown word, negation, existing file, paste
 * placeholder, multi-sentence prompt — so the normal pipeline handles it.
 */
export function resolveDeterministicTurn(
  submission: string,
  ctx: ResolverContext,
): DeterministicResolution | null {
  const raw = submission.trim();
  // Paste chips ("[Text #1]") hide content this matcher can't see.
  if (/\[(?:Text|Image) #\d+/.test(raw)) return null;
  // Multi-line or multi-sentence prompts carry clauses we won't classify.
  if (/\n/.test(raw)) return null;
  if (/[.!?]\s+\S/.test(raw.replace(/\.gitignore/gi, "gitignore"))) return null;
  if (raw.length > 160) return null;

  let text = raw.toLowerCase().replace(/[?!.]+$/g, "");
  for (const [pattern, replacement] of MULTIWORD_NORMALIZATIONS) {
    text = text.replace(pattern, replacement);
  }
  // ".gitignore" survives tokenization as its own word.
  text = text.replace(/\.gitignore/g, " gitignore ");

  const words = text.split(/[\s,/+&]+/).filter(Boolean);
  if (words.length === 0) return null;

  let sawIntent = false;
  let sawGitignore = false;
  const targets: string[] = [];
  for (const word of words) {
    if (GITIGNORE_WORDS.has(word)) {
      sawGitignore = true;
      continue;
    }
    const target = TARGET_ALIASES[word];
    if (target) {
      if (!targets.includes(target)) targets.push(target);
      continue;
    }
    if (INTENT_VERBS.has(word)) {
      sawIntent = true;
      continue;
    }
    if (FILLER_WORDS.has(word) || SEPARATOR_WORDS.has(word)) continue;
    // Unclassified word — negation, extra requirement, anything. Use the model.
    return null;
  }
  if (!sawIntent || !sawGitignore || targets.length === 0) return null;
  // Never overwrite: merging with an existing .gitignore is a judgment call.
  if (ctx.fileExists(".gitignore")) return null;

  const labels = targets.map((t) => GITIGNORE_SECTIONS[t]?.label ?? t);
  return {
    path: ".gitignore",
    content: composeGitignore(targets),
    summary:
      `Created .gitignore for ${labels.join(" + ")} from built-in curated templates ` +
      `(deterministic — no model call). Sections: ${labels.join(", ")}.`,
    targets,
  };
}
