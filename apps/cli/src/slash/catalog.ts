/**
 * catalog.ts — The unified slash-command catalog that powers the REPL menu.
 *
 * Three tiers, merged into one list the typeahead reads from:
 *   1. Built-in REPL commands   (/help, /model, /mode, …) — handled inline by the
 *      REPL. Productized.
 *   2. CLI commands             (every `oxagen --help` command, via
 *      describeCliCommands) — discoverable from the REPL. Productized.
 *   3. Custom commands          (.oxagen/commands/*.md and friends, via the
 *      loader) — user-authored. NOT productized.
 *
 * "Productized" (pre-installed / first-party) entries are flagged so the menu can
 * tell them apart from user commands. Built-in commands additionally carry a
 * stable `color` (see `theme.commandPalette`) so the menu renders their `/name`
 * in that color; CLI and custom entries carry no `color` and render as default
 * text. Names are deduped with precedence builtin > cli > custom, so a
 * REPL-native command always wins over a same-named CLI or user command.
 */
import { loadCommands, type LoadCommandsOptions } from "./loader.js";
import type { CliCommandMeta } from "../program.js";
import { theme } from "../tui/theme.js";

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
  /**
   * Stable hex color for this command's `/name` in the menu, from
   * `theme.commandPalette`. Only builtin commands carry one — CLI and custom
   * entries render as default text.
   */
  color?: string;
}

// theme.commandPalette, named for readability where BUILTIN_SLASH_COMMANDS
// assigns them below. Related commands share a tone (e.g. all memory commands
// are PINK) so color also communicates feature grouping in the menu.
const [CYAN, VIOLET, GREEN, AMBER, PINK, BLUE, TEAL, INDIGO] = theme.commandPalette;

/**
 * The REPL-native slash commands — the ones `handleSubmit` interprets directly
 * (they never shell out). Kept here as the single source of truth so the menu,
 * `/help`, and the handler can't drift. Order is the natural menu order.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<
  Omit<SlashCatalogEntry, "source" | "productized">
> = [
  { name: "help", description: "Show the slash-command help", color: AMBER },
  {
    name: "login",
    description:
      "Show the current Oxagen session. To authenticate interactively, run `oxagen login` in your shell.",
    color: CYAN,
  },
  {
    name: "logout",
    description: "Clear the stored Oxagen session (token + org + workspace) from the global config.",
    color: CYAN,
  },
  {
    name: "init",
    description:
      "Scaffold .oxagen/ project settings, build the local code graph, and print graph statistics + inferred domains",
    color: GREEN,
  },
  {
    name: "model",
    description: "Show the active gateway model, or set it for this session",
    argumentHint: "[slug]",
    color: VIOLET,
  },
  {
    name: "coordinator",
    description:
      "Run turns on the remote gateway or the local on-device LLM (downloads weights on first local use)",
    argumentHint: "[remote|local]",
    color: VIOLET,
  },
  {
    name: "effort",
    description:
      "Show or set the reasoning effort for models with a thinking mode (ignored by models without one)",
    argumentHint: "[low|medium|high|xhigh|max|default]",
    color: VIOLET,
  },
  {
    name: "mode",
    description: "Show or set the permission posture for tool calls",
    argumentHint: "[ask|auto-edit|bypass|readonly]",
    color: BLUE,
  },
  {
    name: "pipeline",
    description: "Toggle prompt evaluation, context injection, and completeness judging",
    argumentHint: "[on|off]",
    color: BLUE,
  },
  {
    name: "verbose",
    description: "Toggle per-phase timing, model+token+cost breakdown, and tool-result telemetry",
    argumentHint: "[on|off]",
    color: BLUE,
  },
  {
    name: "remember",
    description:
      "Capture a memory — infers its kind + weight and saves it to the workspace graph",
    argumentHint: "<text>",
    color: PINK,
  },
  {
    name: "memories",
    description: "Browse this workspace's saved memories (optionally filter by kind)",
    argumentHint: "[kind]",
    color: PINK,
  },
  {
    name: "forget",
    description: "Delete a memory by id",
    argumentHint: "<id>",
    color: PINK,
  },
  {
    name: "replay",
    description: "Show how a past turn was handled (prompt, scores, context, model, judge)",
    argumentHint: "[n|id]",
    color: TEAL,
  },
  { name: "traces", description: "List recent turns you can /replay", color: TEAL },
  { name: "hud", description: "Toggle the heads-up display of running agents", color: TEAL },
  {
    name: "panel",
    description: "Pin or hide the Agent Team + Task Progress side panel (right dock)",
    color: INDIGO,
  },
  { name: "clear", description: "Reset the conversation history", color: INDIGO },
  { name: "exit", description: "Quit the REPL", color: INDIGO },
  { name: "quit", description: "Quit the REPL", color: INDIGO },
];

/** The set of built-in names, for fast membership checks + dedupe. */
export const BUILTIN_SLASH_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_SLASH_COMMANDS.map((c) => c.name),
);

const SOURCE_RANK: Record<SlashSource, number> = { builtin: 0, cli: 1, custom: 2 };

export interface BuildCatalogOptions extends LoadCommandsOptions {
  /** CLI command metadata (from describeCliCommands(buildProgram())). */
  cliCommands: ReadonlyArray<CliCommandMeta>;
}

/**
 * Merge the three tiers into one deduped, menu-ordered catalog. Precedence on a
 * name collision is builtin > cli > custom (the higher tier keeps the slot).
 */
export function buildSlashCatalog(opts: BuildCatalogOptions): SlashCatalogEntry[] {
  const byName = new Map<string, SlashCatalogEntry>();

  for (const c of BUILTIN_SLASH_COMMANDS) {
    byName.set(c.name, { ...c, source: "builtin", productized: true });
  }

  for (const c of opts.cliCommands) {
    if (byName.has(c.name)) continue; // a built-in already owns this name
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
    (a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.name.localeCompare(b.name),
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

/**
 * Filter the catalog to entries whose name starts with `query` (case-insensitive).
 * An empty query returns the whole catalog. Order is preserved from the catalog
 * (builtin → cli → custom, alphabetical within each tier).
 */
export function filterSlashCatalog(
  catalog: ReadonlyArray<SlashCatalogEntry>,
  query: string,
): SlashCatalogEntry[] {
  if (query === "") return [...catalog];
  return catalog.filter((c) => c.name.toLowerCase().startsWith(query));
}
