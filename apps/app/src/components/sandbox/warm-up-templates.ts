/**
 * warm-up-templates.ts — the "give agents something warm to wake up to" presets.
 *
 * A durable sandbox (`agent.sandbox.start`) can run a ONE-TIME `setupCmd` at
 * create time. These templates pair a base image with such a warm-up command so
 * that when an agent later reconnects (same `sessionKey`, `reused: true`) it
 * finds a ready workspace — git initialised, a scaffold in place, deps present —
 * instead of a bare shell. This is the sandbox analogue of "run oxagen init
 * first": pre-warm the filesystem so the agent's first turn is productive.
 *
 * Pure data + a small selector — no React, no server imports — so it is shared
 * by the start form, the detail page, tests, and Storybook alike.
 */

/** Base images accepted by `agent.sandbox.start`. */
export type SandboxImage = "agent" | "node" | "python" | "shell";

export interface WarmUpTemplate {
  /** Stable id used as the form value and the reuse `sessionKey` seed. */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  /** One-line description of what the agent wakes up to. */
  description: string;
  /** Base image the sandbox is provisioned from. */
  image: SandboxImage;
  /**
   * Shell run ONCE at create time. Kept POSIX-sh compatible (`agent.sandbox.exec`
   * runs commands via `sh -c`) and idempotent where practical, so a
   * snapshot-restore re-run is harmless. Empty string = no warm-up (bare image).
   */
  setupCmd: string;
}

// The "oxagen init"-style scaffold: a minimal, opinionated project tree so an
// agent has a README to read, an AGENT.md for mission context, a src entry, and
// a git repo to commit into. Written with printf (portable) rather than a
// heredoc so it survives being passed as a single `sh -c` string.
const OXAGEN_WARM_SCAFFOLD = [
  "set -e",
  "git init -q 2>/dev/null || true",
  "mkdir -p src docs .oxagen",
  "printf '%s\\n' '# Warm Workspace' '' 'Scaffolded by Oxagen so an agent wakes to a ready project.' '' 'Start from src/ and read .oxagen/AGENT.md for mission context.' > README.md",
  "printf '%s\\n' 'node_modules/' '.env' '.venv/' '__pycache__/' > .gitignore",
  "printf '%s\\n' '# Agent context' '' 'Describe the mission, constraints, and where to begin here.' '' '- Entry point: src/' '- Docs: docs/' > .oxagen/AGENT.md",
  "printf '%s\\n' 'console.log(\"hello from a warm sandbox\");' > src/index.js",
  'echo "warm workspace ready"',
].join(" && ");

// Named so it can serve as the guaranteed fallback in templateById() without a
// possibly-undefined array index (noUncheckedIndexedAccess).
const OXAGEN_AGENT_TEMPLATE: WarmUpTemplate = {
  id: "oxagen-agent",
  label: "Oxagen agent workspace",
  description:
    "Debian + git, pre-scaffolded (README, .oxagen/AGENT.md, src/) — a warm project for an agent to wake up to.",
  image: "agent",
  setupCmd: OXAGEN_WARM_SCAFFOLD,
};

export const WARM_UP_TEMPLATES: readonly WarmUpTemplate[] = [
  OXAGEN_AGENT_TEMPLATE,
  {
    id: "node",
    label: "Node workspace",
    description: "Node base with git; runs npm init so package.json is ready.",
    image: "node",
    setupCmd: 'npm init -y >/dev/null 2>&1 && echo "node project initialized"',
  },
  {
    id: "python",
    label: "Python workspace",
    description:
      "Python base with git; creates a virtualenv and an empty requirements.txt.",
    image: "python",
    setupCmd:
      'python -m venv .venv >/dev/null 2>&1 || true; : > requirements.txt && echo "python project initialized"',
  },
  {
    id: "blank",
    label: "Blank sandbox",
    description: "Bare agent image with git — no warm-up, start from scratch.",
    image: "agent",
    setupCmd: "",
  },
] as const;

export const DEFAULT_TEMPLATE_ID = OXAGEN_AGENT_TEMPLATE.id;

/** Look up a template by id; falls back to the default when unknown. */
export function templateById(id: string | null | undefined): WarmUpTemplate {
  return (
    WARM_UP_TEMPLATES.find((t) => t.id === id) ??
    WARM_UP_TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID) ??
    OXAGEN_AGENT_TEMPLATE
  );
}
