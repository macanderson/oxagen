/**
 * catalog.ts — The unified slash-command catalog that powers the REPL menu.
 *
 * Three tiers, merged into one list the typeahead reads from:
 *   1. Built-in REPL commands   (/help, /model, /mode, …) — handled inline by the
 *      REPL. Productized.
 *   2. CLI commands             (every `oxagen --help` command, via
 *      describeCliCommands) — discoverable from the REPL. Productized.
 *   3. Custom commands          (.oxagen/commands/*.toml, via the
 *      loader) — user-authored. NOT productized.
 *
 * "Productized" (pre-installed / first-party) entries are flagged so the menu can
 * mark them (a lock glyph) and tell them apart from user commands. Names are
 * deduped with precedence builtin > cli > custom, so a REPL-native command always
 * wins over a same-named CLI or user command.
 */
import { loadCommands, type LoadCommandsOptions } from "./loader.js";
import type { CliCommandMeta } from "../commands/meta.js";

/** Where a catalog entry originates. */
export type SlashSource = "builtin" | "cli" | "custom";

export interface SlashCatalogEntry {
  /** Command name, invoked as `/name` (no leading slash here). */
  name: string;
  /** One-line description shown in the menu (may be wrapped when long). */
  description: string;
  /** Optional argument hint, e.g. "[compact|fullscreen]" or "<query>". */
  argumentHint?: string;
  /** Origin tier. */
  source: SlashSource;
  /** First-party / pre-installed (built-in or CLI). Custom commands are false. */
  productized: boolean;
}

/**
 * The REPL-native slash commands — the ones `handleSubmit` interprets directly
 * (they never shell out). Kept here as the single source of truth so the menu,
 * `/help`, and the handler can't drift. Ordered by group (session · project ·
 * turn config · memory · history · interface · lifecycle) — `buildSlashCatalog`
 * preserves this order for built-ins, so the menu reads top-to-bottom by group.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<
  Omit<SlashCatalogEntry, "source" | "productized">
> = [
  { name: "help", description: "List the slash commands" },

  // Session
  {
    name: "login",
    description: "Show the current session (run `oxagen login` to sign in)",
  },
  {
    name: "logout",
    description: "Clear the stored session — token, org, workspace",
  },

  // Project
  {
    name: "init",
    description: "Scaffold .oxagen/ settings and link the workspace",
  },

  // Turn configuration
  {
    name: "model",
    description: "Show or set the WORKER model (alias for /worker-model)",
    argumentHint: "[slug]",
  },
  {
    name: "worker-model",
    description: "Show or set the worker (executor) model",
    argumentHint: "[slug]",
  },
  {
    name: "judge-model",
    description: "Show or set the judge (completeness advisor) model",
    argumentHint: "[slug]",
  },
  {
    name: "triage-model",
    description:
      "Show or set the triage/coordinator (planner + evaluator) model",
    argumentHint: "[slug]",
  },
  {
    name: "coordinator",
    description: "Run turns on the remote gateway or a local on-device model",
    argumentHint: "[remote|local]",
  },
  {
    name: "effort",
    description: "Show or set reasoning effort for thinking-capable models",
    argumentHint: "[low|medium|high|xhigh|max|default]",
  },
  {
    name: "budget",
    description:
      "Show or set a per-turn dollar budget (grace | prompt | enforce)",
    argumentHint: "off | <usd> [grace|prompt|enforce] | mode <mode> | status",
  },
  {
    name: "mode",
    description: "Show or set the tool-permission mode",
    argumentHint: "[ask|auto-edit|bypass|readonly]",
  },
  {
    name: "pipeline",
    description: "Toggle prompt evaluation, context injection, and judging",
    argumentHint: "[on|off]",
  },
  {
    name: "plan",
    description:
      "Plan-only mode — prompts produce a task plan without executing; `run` executes the last plan",
    argumentHint: "[on|off|status|run]",
  },
  {
    name: "config",
    description:
      "Browse and edit tiered config (repo ▸ workspace ▸ user ▸ org) — `doctor` scans it",
    argumentHint: "[doctor]",
  },
  {
    name: "import",
    description: "Scan Claude Code, Codex, Cursor, and legacy Oxagen artifacts",
    argumentHint: "[--from <platform>] [--dry-run]",
  },
  {
    name: "verbose",
    description: "Toggle per-phase timing, token/cost, and tool telemetry",
    argumentHint: "[on|off]",
  },
  {
    name: "debug",
    description:
      "Toggle the JSONL debug file log (~/.oxagen/logs/cli.output) for this session",
    argumentHint: "[on|off|status]",
  },

  // Memory
  {
    name: "remember",
    description: "Save a memory to the workspace (kind + weight inferred)",
    argumentHint: "<text>",
  },
  {
    name: "memories",
    description: "Browse saved memories, optionally by kind",
    argumentHint: "[kind]",
  },
  {
    name: "forget",
    description: "Delete a memory by id",
    argumentHint: "<id>",
  },

  // History
  {
    name: "replay",
    description: "Replay how a past turn was handled",
    argumentHint: "[n|id]",
  },
  { name: "traces", description: "List recent turns you can /replay" },

  // Interface
  {
    name: "diff",
    description:
      "Review working-tree changes — pick a changed file, view its diff",
    argumentHint: "[path]",
  },
  {
    name: "files",
    description:
      "Files Touched — every file the agent read/created/updated/deleted this session; view diffs, open in your editor",
  },
  { name: "hud", description: "Toggle the running-agents heads-up display" },
  {
    name: "tasks",
    description:
      "Planner task inspector — the current turn's task plan, live (Ctrl+T)",
  },
  {
    name: "swarm",
    description:
      "Agent swarm view — every live agent; Ctrl+X twice kills one (Ctrl+S)",
  },
  {
    name: "marketplace",
    description:
      "Browse & install skills, MCP servers, agents, knowledge sources, integrations",
  },
  {
    name: "prompts",
    description:
      "Saved prompts (.oxagen/prompts) — pick one to insert into the composer",
  },
  {
    name: "create-command",
    description:
      "Scaffold a custom slash command (.oxagen/commands/<name>.toml)",
  },
  {
    name: "create-agent",
    description:
      "Scaffold a named agent definition (.oxagen/agents/<name>.toml)",
  },
  {
    name: "create-skill",
    description: "Scaffold a skill (.oxagen/skills/<name>/skill.toml)",
  },
  {
    name: "create-prompt",
    description: "Scaffold a saved prompt (.oxagen/prompts/<name>.md)",
  },
  {
    name: "dispatch",
    description:
      "Async dispatch mode — background task prompts to the fleet (` &` forces bg, `=` forces inline)",
    argumentHint: "[on|off|cap <n>|status]",
  },
  { name: "panel", description: "Toggle the Agent Team + Task side panel" },
  {
    name: "mouse",
    description:
      "Toggle mouse-wheel scroll (off by default so native copy/paste works)",
  },
  {
    name: "motion",
    description:
      "Set animation level — full, reduced (no invaders/border flash), off (none, incl. thinking indicator)",
    argumentHint: "[full|reduced|off]",
  },
  { name: "clear", description: "Clear the conversation history" },

  // Lifecycle
  { name: "exit", description: "Quit the REPL" },
  { name: "quit", description: "Quit the REPL (alias of /exit)" },
];

/** The set of built-in names, for fast membership checks + dedupe. */
export const BUILTIN_SLASH_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_SLASH_COMMANDS.map((c) => c.name),
);

const SOURCE_RANK: Record<SlashSource, number> = {
  builtin: 0,
  cli: 1,
  custom: 2,
};

/**
 * Prefix used to disambiguate a CLI command whose bare name is shadowed by a
 * built-in (e.g. `config`, `init`). `/cli:config` always resolves to the CLI
 * command tree, never the built-in — see `buildSlashCatalog` and the REPL
 * dispatcher, which strips this prefix before resolving/running the command.
 */
export const CLI_DISAMBIGUATION_PREFIX = "cli:";

export interface BuildCatalogOptions extends LoadCommandsOptions {
  /** CLI command metadata (from describeCliCommands(buildProgram())). */
  cliCommands: ReadonlyArray<CliCommandMeta>;
}

/**
 * Merge the three tiers into one deduped, menu-ordered catalog. Precedence on a
 * name collision is builtin > cli > custom (the higher tier keeps the slot).
 * Within a tier, insertion order is preserved (stable sort by tier only): so
 * built-ins keep their grouped BUILTIN_SLASH_COMMANDS order, CLI keep program
 * order, custom keep load order — no alphabetical reshuffle.
 */
export function buildSlashCatalog(
  opts: BuildCatalogOptions,
): SlashCatalogEntry[] {
  const byName = new Map<string, SlashCatalogEntry>();

  for (const c of BUILTIN_SLASH_COMMANDS) {
    byName.set(c.name, { ...c, source: "builtin", productized: true });
  }

  for (const c of opts.cliCommands) {
    if (byName.has(c.name)) {
      // A built-in (or an earlier CLI command — top-level `describeCliCommands`
      // order is stable) already owns this bare name. Rather than silently
      // dropping the CLI command, expose it under a `cli:<name>` alias so it
      // stays reachable — see
      // CLI_DISAMBIGUATION_PREFIX and the REPL dispatcher in interactive.tsx,
      // which strips the prefix back off before resolving/running it.
      const aliased = `${CLI_DISAMBIGUATION_PREFIX}${c.name}`;
      if (byName.has(aliased)) continue; // pathological double-collision — give up quietly
      byName.set(aliased, {
        name: aliased,
        description: `${c.description} (shadowed by a built-in /${c.name} — use this alias)`,
        argumentHint: c.argumentHint,
        source: "cli",
        productized: true,
      });
      continue;
    }
    byName.set(c.name, {
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      source: "cli",
      productized: true,
    });
  }

  for (const c of loadCommands(opts).values()) {
    if (byName.has(c.name)) continue; // builtin/CLI already owns this name
    byName.set(c.name, {
      name: c.name,
      description: c.description,
      argumentHint: c.argumentHint,
      source: "custom",
      productized: false,
    });
  }

  return [...byName.values()].sort(
    (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source],
  );
}

/**
 * Extract the slash-command prefix the user is typing, or null when the menu
 * should be hidden. The menu is live only while the buffer is a single
 * `/word` token — once a space is typed (arguments begin) the menu closes.
 *
 *   "/mo"      → "mo"
 *   "/"        → ""        (show everything)
 *   "/tui c"   → null      (typing args; menu closed)
 *   "find foo" → null      (not a slash command)
 */
export function slashQuery(value: string): string | null {
  const m = /^\/(\S*)$/.exec(value);
  return m ? m[1]!.toLowerCase() : null;
}

/** Match tiers, highest-first. Exposed for tests/readers of `matchScore`. */
export const MATCH_PREFIX = 3;
export const MATCH_SUBSTRING = 2;
export const MATCH_SUBSEQUENCE = 1;
export const MATCH_NONE = 0;

/**
 * How well `query` matches `name` (both already lower-cased). Returns a flat
 * TIER score: a prefix (`mo` → `model`) beats a mid-word substring
 * (`del` → `model`), which beats a scattered subsequence (`mdl` → `model`);
 * anything else is 0. The score deliberately carries no intra-tier ordering —
 * `filterSlashCatalog` uses the catalog's own order as the tie-break so two
 * equally-tiered commands keep their stable, documented order (e.g. `/model`
 * before `/mode`) and the list never jitters between keystrokes.
 */
export function matchScore(name: string, query: string): number {
  if (query === "") return MATCH_PREFIX;
  if (name.startsWith(query)) return MATCH_PREFIX;
  if (name.includes(query)) return MATCH_SUBSTRING;
  // Subsequence: every query char appears in order, not necessarily adjacent.
  let qi = 0;
  for (let ni = 0; ni < name.length && qi < query.length; ni++) {
    if (name[ni] === query[qi]) qi++;
  }
  return qi === query.length ? MATCH_SUBSEQUENCE : MATCH_NONE;
}

/**
 * Filter + rank the catalog against `query` (case-insensitive). An empty query
 * returns the whole catalog unchanged. Otherwise entries are scored by
 * `matchScore` (prefix ▸ substring ▸ subsequence) and sorted best-first; ties
 * keep the catalog's original order (builtin → cli → custom, insertion order
 * within a tier) so the list is fully deterministic and never reorders on an
 * equal-scoring keystroke.
 */
export function filterSlashCatalog(
  catalog: ReadonlyArray<SlashCatalogEntry>,
  query: string,
): SlashCatalogEntry[] {
  if (query === "") return [...catalog];
  const scored = catalog
    .map((entry, index) => ({
      entry,
      index,
      score: matchScore(entry.name.toLowerCase(), query),
    }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.entry);
}
