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
 * Each preset also carries a truthful `contents` manifest — the language
 * runtimes + versions, package managers, and pre-installed system packages that
 * are actually baked into its Modal image (source of truth:
 * `ops/modal-sandbox/runner.py` `DURABLE_IMAGES`). The warm-up template card
 * renders this so a person picking a sandbox knows exactly what their agent
 * will be able to run — no guessing from an opaque image ref.
 *
 * Pure data + a small selector — no React, no server imports — so it is shared
 * by the start form, the detail page, tests, and Storybook alike. Keep it in
 * sync with `DURABLE_IMAGES` whenever an image's toolchain changes.
 */

/** Base images accepted by `agent.sandbox.start`. */
export type SandboxImage = "agent" | "node" | "python" | "shell";

/** A language runtime baked into an image, with its version. */
export interface TemplateLanguage {
  /** Display name, e.g. "Node.js" or "Python". */
  name: string;
  /** Version string as baked in, e.g. "20" or "3.12". */
  version: string;
}

/**
 * The truthful "what's inside" manifest for a template's image. Everything here
 * reflects the real Modal image build in `ops/modal-sandbox/runner.py`; if that
 * changes, this must change with it.
 */
export interface TemplateContents {
  /** Base OS / distro line, e.g. "Debian 12 (slim)". */
  base: string;
  /** Language runtimes present, with versions. Empty for a system-only base. */
  languages: TemplateLanguage[];
  /** Package managers available to the agent (npm, pip, apt, …). */
  packageManagers: string[];
  /** Notable pre-installed system packages (from apt), user-facing names. */
  systemPackages: string[];
  /**
   * Extra baked-in capabilities worth calling out that aren't plain packages —
   * e.g. a headless browser. Optional; omitted when there's nothing special.
   */
  highlights?: string[];
}

export interface WarmUpTemplate {
  /** Stable id used as the form value and the reuse `sessionKey` seed. */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  /** One-line description of what the agent wakes up to. */
  description: string;
  /**
   * Lucide icon name (PascalCase) for the card. Monochromatic by design — the
   * card renders it in the foreground/muted tone, never a brand colour. Kept as
   * a string so this module stays React-free; the card maps it to a component.
   */
  icon: string;
  /** Base image the sandbox is provisioned from. */
  image: SandboxImage;
  /** Truthful manifest of the image's baked-in toolchain. */
  contents: TemplateContents;
  /**
   * Shell run ONCE at create time. Kept POSIX-sh compatible (`agent.sandbox.exec`
   * runs commands via `sh -c`) and idempotent where practical, so a
   * snapshot-restore re-run is harmless. Empty string = no warm-up (bare image).
   */
  setupCmd: string;
  /**
   * True for the "start from scratch" preset — the card shows the minimal-base
   * explainer plus how to install a toolchain and snapshot it into a reusable
   * template, instead of a warm-up command.
   */
  isBlank?: boolean;
}

// The fast-search trio (ripgrep, fd, fzf) is baked into EVERY durable image by
// policy — see `_FAST_SEARCH_APT` in runner.py — so it's listed on every preset.
const FAST_SEARCH = ["ripgrep", "fd", "fzf"] as const;

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
    "Full agent image — Debian + Python, git, and a headless browser — pre-scaffolded (README, .oxagen/AGENT.md, src/) so an agent wakes to a ready project.",
  icon: "Bot",
  image: "agent",
  contents: {
    base: "Debian 12 (slim)",
    languages: [{ name: "Python", version: "3.12" }],
    packageManagers: ["pip", "apt"],
    systemPackages: ["git", "curl", ...FAST_SEARCH],
    highlights: ["Playwright 1.49 + Chromium (headless browser automation)"],
  },
  setupCmd: OXAGEN_WARM_SCAFFOLD,
};

export const WARM_UP_TEMPLATES: readonly WarmUpTemplate[] = [
  OXAGEN_AGENT_TEMPLATE,
  {
    id: "node",
    label: "Node workspace",
    description:
      "Node.js 20 with npm and git; runs npm init so package.json is ready.",
    icon: "Hexagon",
    image: "node",
    contents: {
      base: "Debian 12 (node:20)",
      languages: [{ name: "Node.js", version: "20" }],
      packageManagers: ["npm", "npx", "apt"],
      systemPackages: ["git", ...FAST_SEARCH],
    },
    setupCmd: 'npm init -y >/dev/null 2>&1 && echo "node project initialized"',
  },
  {
    id: "python",
    label: "Python workspace",
    description:
      "Python 3.12 with pip and git; creates a virtualenv and an empty requirements.txt.",
    icon: "Braces",
    image: "python",
    contents: {
      base: "Debian 12 (slim)",
      languages: [{ name: "Python", version: "3.12" }],
      packageManagers: ["pip", "venv", "apt"],
      systemPackages: ["git", ...FAST_SEARCH],
    },
    setupCmd:
      'python -m venv .venv >/dev/null 2>&1 || true; : > requirements.txt && echo "python project initialized"',
  },
  {
    id: "blank",
    label: "Blank sandbox",
    description:
      "The leanest base — Debian, git, and fast-search only. No language toolchain beyond the system Python. Install what you need, then snapshot it into a reusable template.",
    icon: "SquareTerminal",
    image: "shell",
    contents: {
      base: "Debian 12 (slim)",
      languages: [{ name: "Python", version: "3.12 (system)" }],
      packageManagers: ["apt"],
      systemPackages: ["git", ...FAST_SEARCH],
    },
    setupCmd: "",
    isBlank: true,
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
