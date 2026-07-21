/**
 * cli-bridge.ts — the REPL's inline capture-execution seam (PR C item 11).
 *
 * `interactive.tsx` used to dead-end every CLI-sourced slash command with
 * "run it from your shell", even for commands that are perfectly safe and
 * fast to run inline (`/cost`, `/graph:search`, `/memory:list`, …). This module
 * is what makes those commands actually run *inside* the REPL: their output is
 * captured (via `../lib/capture-writer.ts`) instead of touching the real
 * `process.stdout`/`console.log` — required, because the REPL is an Ink app
 * and anything that writes to the real terminal while Ink owns raw mode
 * corrupts the render tree — and folded into a single assistant message.
 *
 * Flag/positional parsing reuses the *real* Commander tree (`buildProgram()`)
 * rather than a hand-rolled parser: `Command.parseOptions()` applies the exact
 * same option definitions (coercion functions, `--no-x` negation, repeatable
 * `collect` options, defaults) that `oxagen <cmd> --help` documents, so there
 * is exactly one place flags are declared — no drift between the shell CLI
 * and the REPL's inline seam. The program factory is injected by the caller
 * (ultimately program.tsx via ReplOptions.buildProgram — this module never
 * imports the composition root statically) and rebuilt fresh on every call
 * (documented as side-effect-free in program.tsx) specifically so option state
 * (e.g. a `collect`-accumulated array option) never leaks between unrelated
 * invocations sharing one long-lived REPL process.
 *
 * Three buckets, matching the slash catalog's "cli" tier:
 *   1. `REGISTRY` below — read-only/safe commands wired to run inline.
 *   2. `EXTERNAL_ONLY_TOP_LEVEL` — long-running/interactive commands (they own
 *      the terminal or run indefinitely) get an honest "opens outside the
 *      REPL" message, never the old dead-end.
 *   3. Everything else — not yet ported to this seam — keeps the shell-out
 *      hint (now worded as "not yet available inline", which is true, rather
 *      than the old blanket "This is an oxagen CLI command" phrasing that
 *      read as a dead-end even for commands that could have run).
 */
import type { Command } from "commander";
import { captureWriter, type CommandWriter } from "../lib/capture-writer.js";
import { CLI_DISAMBIGUATION_PREFIX } from "../slash/catalog.js";

export interface CliDispatchResult {
  ok: boolean;
  output: string;
}

type CliAdapter = (
  rawArgs: string,
  node: Command,
  writer: CommandWriter,
) => Promise<void>;

/**
 * Top-level command names that must never run inline — they own the terminal
 * (an Ink dashboard/fleet view) or run indefinitely (a daemon, a best-of-N
 * solve). Matched against the *first* path segment, so every subcommand under
 * `daemon` (`daemon:start`, `daemon:session:list`, …) is covered too.
 *
 * NOTE on the audit's original "(daemon, solve, view, agent)" list: `agent`
 * (singular — `oxagen agent list/show/new`, named *agent definition* CRUD) is
 * NOT long-running or interactive — it is fast, synchronous config-file
 * management, same shape as `settings` or `mcp`. It is intentionally left out
 * of this set; it just isn't wired into REGISTRY yet (falls through to the
 * generic "not yet available inline" message like the rest of the unwired CLI
 * surface). `agents` (plural — the live fleet dashboard) is the one that
 * actually needs this treatment, and is included below.
 */
const EXTERNAL_ONLY_TOP_LEVEL: ReadonlySet<string> = new Set([
  "daemon",
  "solve",
  "view",
  "agents",
]);

/** Split a catalog/dispatch name into its command path segments. */
function splitPath(name: string): string[] {
  const bare = name.startsWith(CLI_DISAMBIGUATION_PREFIX)
    ? name.slice(CLI_DISAMBIGUATION_PREFIX.length)
    : name;
  return bare.split(":");
}

/** True when `name` (optionally `cli:`-prefixed) names a command that owns the
 * terminal or runs indefinitely — never dispatch it inline. */
export function isExternalOnlyCliCommand(name: string): boolean {
  const [top] = splitPath(name);
  return top !== undefined && EXTERNAL_ONLY_TOP_LEVEL.has(top);
}

/** True when `name` (optionally `cli:`-prefixed) is wired into the inline
 * capture-execution seam. */
export function isInlineDispatchableCliCommand(name: string): boolean {
  return splitPath(name).join(":") in REGISTRY;
}

/** Render a catalog name back into the `oxagen <cmd> <subcmd>` shell form the
 * user would type — strips the `cli:` disambiguation prefix and turns
 * colon-joined subcommand path segments back into spaces. */
export function toShellCommand(name: string): string {
  return splitPath(name).join(" ");
}

function findCommandNode(
  root: Command,
  path: readonly string[],
): Command | undefined {
  let node: Command | undefined = root;
  for (const part of path) {
    node = node?.commands.find((c) => c.name() === part);
    if (!node) return undefined;
  }
  return node;
}

/** Parse `raw` against `node`'s declared options (coercion, negation,
 * `collect`, defaults all apply — same definitions `--help` reads). Returns
 * the parsed options plus the leftover positional operands, in order. */
function parseArgs(
  node: Command,
  raw: string,
): { opts: Record<string, unknown>; operands: string[] } {
  const tokens = raw.trim().length > 0 ? raw.trim().split(/\s+/) : [];
  const { operands } = node.parseOptions(tokens);
  return { opts: node.opts(), operands };
}

/** Friendly usage failure — thrown, not exited (see capture-writer.ts docs):
 * this only ever runs inside `runInlineCliCommand`'s try/catch below. */
class UsageError extends Error {}

function requirePositional(
  operands: string[],
  index: number,
  label: string,
): string {
  const value = operands[index];
  if (!value) throw new UsageError(`Missing ${label}.`);
  return value;
}

// ── REGISTRY — one adapter per inline-dispatchable command ──────────────────

const REGISTRY: Record<string, CliAdapter> = {
  cost: async (rawArgs, node, writer) => {
    const { handleCost } = await import("../commands/cost.js");
    const { opts } = parseArgs(node, rawArgs);
    await handleCost(opts as Parameters<typeof handleCost>[0], writer);
  },

  trace: async (rawArgs, node, writer) => {
    const { handleTrace } = await import("../commands/trace.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const executionId = requirePositional(
      operands,
      0,
      "<executionId> — usage: /trace <executionId> [--json]",
    );
    await handleTrace(executionId, opts as { json?: boolean }, writer);
  },

  "models:list": async (rawArgs, node, writer) => {
    const { handleModelsList } = await import("../commands/models.js");
    const { opts } = parseArgs(node, rawArgs);
    await handleModelsList(opts as { json?: boolean }, writer);
  },
  "models:active": async (rawArgs, node, writer) => {
    const { handleModelsActive } = await import("../commands/models.js");
    const { opts } = parseArgs(node, rawArgs);
    await handleModelsActive(opts as { json?: boolean }, writer);
  },
  "models:pull": async (rawArgs, node, writer) => {
    const { handleModelsPull } = await import("../commands/models.js");
    const { opts } = parseArgs(node, rawArgs);
    await handleModelsPull(opts as { json?: boolean }, writer);
  },
  "models:status": async (rawArgs, node, writer) => {
    const { handleModelsStatus } = await import("../commands/models.js");
    const { opts } = parseArgs(node, rawArgs);
    await handleModelsStatus(opts as { json?: boolean }, writer);
  },
  "models:use": async (rawArgs, node, writer) => {
    const { handleModelsUse } = await import("../commands/models.js");
    const { operands } = parseArgs(node, rawArgs);
    const id = requirePositional(operands, 0, "<id> — usage: /models:use <id>");
    await handleModelsUse(id, writer);
  },

  "graph:search": async (rawArgs, node, writer) => {
    const { handleGraphSearch } = await import("../commands/graph.search.js");
    const { opts } = parseArgs(node, rawArgs);
    const query = opts["query"] as string | undefined;
    if (!query) {
      throw new UsageError(
        "Missing -q/--query. Usage: /graph:search -q <text> [-l labels] [-n limit]",
      );
    }
    await handleGraphSearch(
      {
        query,
        labels: opts["labels"] as string | undefined,
        limit: opts["limit"] as string | undefined,
      },
      writer,
    );
  },
  "memory:list": async (rawArgs, node, writer) => {
    const { handleMemoryList } = await import("../commands/memory.js");
    const { opts } = parseArgs(node, rawArgs);
    await handleMemoryList(
      opts as Parameters<typeof handleMemoryList>[0],
      writer,
    );
  },
  "memory:show": async (rawArgs, node, writer) => {
    const { handleMemoryShow } = await import("../commands/memory.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const id = requirePositional(
      operands,
      0,
      "<id> — usage: /memory:show <id> [--json]",
    );
    await handleMemoryShow(id, opts as { json?: boolean }, writer);
  },
  "memory:edit": async (rawArgs, node, writer) => {
    const { handleMemoryEdit } = await import("../commands/memory.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const id = requirePositional(
      operands,
      0,
      "<id> — usage: /memory:edit <id> [--lesson t] [--kind k] [--source s]",
    );
    await handleMemoryEdit(
      id,
      opts as Parameters<typeof handleMemoryEdit>[1],
      writer,
    );
  },
  "memory:salience": async (rawArgs, node, writer) => {
    const { handleMemorySalience } = await import("../commands/memory.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const id = requirePositional(
      operands,
      0,
      "<id> — usage: /memory:salience <id> [--confidence n] [--enforcement n] [--status s]",
    );
    await handleMemorySalience(
      id,
      opts as Parameters<typeof handleMemorySalience>[1],
      writer,
    );
  },
  "memory:promote": async (rawArgs, node, writer) => {
    const { handleMemoryPromote } = await import("../commands/memory.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const id = requirePositional(
      operands,
      0,
      '<id> — usage: /memory:promote <id> --to rule|fact --rationale "…"',
    );
    if (!opts["to"] || !opts["rationale"]) {
      throw new UsageError(
        'Missing --to/--rationale. Usage: /memory:promote <id> --to rule|fact --rationale "…"',
      );
    }
    await handleMemoryPromote(
      id,
      opts as Parameters<typeof handleMemoryPromote>[1],
      writer,
    );
  },
  "memory:candidates": async (rawArgs, node, writer) => {
    const { handleMemoryCandidates } = await import("../commands/memory.js");
    const { opts } = parseArgs(node, rawArgs);
    await handleMemoryCandidates(
      opts as Parameters<typeof handleMemoryCandidates>[0],
      writer,
    );
  },
  "memory:rm": async (rawArgs, node, writer) => {
    const { handleMemoryRemove } = await import("../commands/memory.js");
    const { operands } = parseArgs(node, rawArgs);
    const id = requirePositional(operands, 0, "<id> — usage: /memory:rm <id>");
    await handleMemoryRemove(id, writer);
  },
  "memory:import": async (rawArgs, node, writer) => {
    const { handleMemoryImport } = await import("../commands/memory.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    if (operands.length === 0) {
      throw new UsageError(
        "Usage: /memory:import <file...> [--node ref] [--yes] [--json]",
      );
    }
    await handleMemoryImport(
      operands,
      opts as Parameters<typeof handleMemoryImport>[1],
      writer,
    );
  },

  "env:list": async (rawArgs, node, writer) => {
    const { handleEnvList } = await import("../commands/env.js");
    const { opts } = parseArgs(node, rawArgs);
    await handleEnvList(opts as { json?: boolean }, writer);
  },
  "env:get": async (rawArgs, node, writer) => {
    const { handleEnvGet } = await import("../commands/env.js");
    const { operands } = parseArgs(node, rawArgs);
    const idOrSlug = requirePositional(
      operands,
      0,
      "<idOrSlug> — usage: /env:get <idOrSlug>",
    );
    await handleEnvGet(idOrSlug, {}, writer);
  },
  "env:create": async (rawArgs, node, writer) => {
    const { handleEnvCreate } = await import("../commands/env.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const name = requirePositional(
      operands,
      0,
      "<name> — usage: /env:create <name> [--slug s] [--description t]",
    );
    await handleEnvCreate(
      name,
      opts as Parameters<typeof handleEnvCreate>[1],
      writer,
    );
  },
  "env:update": async (rawArgs, node, writer) => {
    const { handleEnvUpdate } = await import("../commands/env.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const idOrSlug = requirePositional(
      operands,
      0,
      "<idOrSlug> — usage: /env:update <idOrSlug> [--name] [--slug] [--description] [--active]",
    );
    const rawOpts = opts as {
      name?: string;
      slug?: string;
      description?: string;
      active?: boolean;
      inactive?: boolean;
    };
    const active = rawOpts.active ? true : rawOpts.inactive ? false : undefined;
    await handleEnvUpdate(
      idOrSlug,
      {
        name: rawOpts.name,
        slug: rawOpts.slug,
        description: rawOpts.description,
        active,
      },
      writer,
    );
  },
  "env:rm": async (rawArgs, node, writer) => {
    const { handleEnvRemove } = await import("../commands/env.js");
    const { operands } = parseArgs(node, rawArgs);
    const idOrSlug = requirePositional(
      operands,
      0,
      "<idOrSlug> — usage: /env:rm <idOrSlug>",
    );
    await handleEnvRemove(idOrSlug, writer);
  },
  "env:set-default": async (rawArgs, node, writer) => {
    const { handleEnvSetDefault } = await import("../commands/env.js");
    const { operands } = parseArgs(node, rawArgs);
    const idOrSlug = requirePositional(
      operands,
      0,
      "<idOrSlug> — usage: /env:set-default <idOrSlug>",
    );
    await handleEnvSetDefault(idOrSlug, writer);
  },

  "mcp:add": async (rawArgs, node, writer) => {
    const { mcpAdd } = await import("../commands/mcp.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const name = requirePositional(
      operands,
      0,
      '<name> — usage: /mcp:add <name> --command "…" | --url <url>',
    );
    mcpAdd(
      name,
      {
        command: opts["command"] as string | undefined,
        arg: opts["arg"] as string[] | undefined,
        url: opts["url"] as string | undefined,
        transport: opts["transport"] as string | undefined,
        auth: opts["auth"] as string | undefined,
        envToken: opts["envToken"] as string | undefined,
        header: opts["header"] as string[] | undefined,
        scope: opts["scope"] as string | undefined,
      },
      {},
      writer,
    );
  },
  "mcp:list": async (_rawArgs, _node, writer) => {
    const { mcpList } = await import("../commands/mcp.js");
    mcpList({}, writer);
  },
  "mcp:remove": async (rawArgs, node, writer) => {
    const { mcpRemove } = await import("../commands/mcp.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const name = requirePositional(
      operands,
      0,
      "<name> — usage: /mcp:remove <name>",
    );
    mcpRemove(name, opts["scope"] as string | undefined, {}, writer);
  },
  "mcp:enable": async (rawArgs, node, writer) => {
    const { mcpSetEnabled } = await import("../commands/mcp.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const name = requirePositional(
      operands,
      0,
      "<name> — usage: /mcp:enable <name>",
    );
    mcpSetEnabled(name, true, opts["scope"] as string | undefined, {}, writer);
  },
  "mcp:disable": async (rawArgs, node, writer) => {
    const { mcpSetEnabled } = await import("../commands/mcp.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const name = requirePositional(
      operands,
      0,
      "<name> — usage: /mcp:disable <name>",
    );
    mcpSetEnabled(name, false, opts["scope"] as string | undefined, {}, writer);
  },
  "mcp:check": async (rawArgs, node, writer) => {
    const { mcpCheck } = await import("../commands/mcp.js");
    const { operands } = parseArgs(node, rawArgs);
    await mcpCheck(operands[0], {}, writer);
  },

  logs: async (rawArgs, node, writer) => {
    const { handleLogs } = await import("../commands/logs.js");
    const { opts } = parseArgs(node, rawArgs);
    // --follow is never honored inline (see logs.ts's own writer-based guard);
    // stripped here too so the intent is visible at the call site.
    const { follow: _follow, ...rest } = opts as {
      follow?: boolean;
      [k: string]: unknown;
    };
    await handleLogs(rest as Parameters<typeof handleLogs>[0], writer);
  },

  settings: async (_rawArgs, _node, writer) => {
    const { settingsShow } = await import("../commands/settings.js");
    settingsShow({}, writer);
  },
  "settings:path": async (_rawArgs, _node, writer) => {
    const { settingsPath } = await import("../commands/settings.js");
    settingsPath({}, writer);
  },
  "settings:get": async (rawArgs, node, writer) => {
    const { settingsGet } = await import("../commands/settings.js");
    const { operands } = parseArgs(node, rawArgs);
    const key = requirePositional(
      operands,
      0,
      "<key> — usage: /settings:get <key>",
    );
    settingsGet(key, {}, writer);
  },
  "settings:set": async (rawArgs, node, writer) => {
    const { settingsSet } = await import("../commands/settings.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const key = requirePositional(
      operands,
      0,
      "<key> <value> — usage: /settings:set <key> <value> [--scope s]",
    );
    const value = requirePositional(
      operands,
      1,
      "<value> — usage: /settings:set <key> <value> [--scope s]",
    );
    settingsSet(key, value, opts["scope"] as string | undefined, {}, writer);
  },
  "settings:validate": async (_rawArgs, _node, writer) => {
    const { settingsValidate } = await import("../commands/settings.js");
    settingsValidate({}, writer);
  },
  "settings:init": async (rawArgs, node, writer) => {
    const { settingsInit } = await import("../commands/settings.js");
    const { opts } = parseArgs(node, rawArgs);
    settingsInit(opts["scope"] as string | undefined, {}, writer);
  },

  "sandbox:files": async (rawArgs, node, writer) => {
    const { handleSandboxFiles } = await import("../commands/sandbox.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const sessionId = requirePositional(
      operands,
      0,
      "<sessionId> — usage: /sandbox:files <sessionId> [--path p] [--depth n] [--json]",
    );
    await handleSandboxFiles(
      sessionId,
      opts as Parameters<typeof handleSandboxFiles>[1],
      writer,
    );
  },

  "sandbox:cat": async (rawArgs, node, writer) => {
    const { handleSandboxCat } = await import("../commands/sandbox.js");
    const { opts, operands } = parseArgs(node, rawArgs);
    const sessionId = requirePositional(
      operands,
      0,
      "<sessionId> — usage: /sandbox:cat <sessionId> <path> [--max-bytes n] [--json]",
    );
    const path = requirePositional(
      operands,
      1,
      "<path> — usage: /sandbox:cat <sessionId> <path> [--max-bytes n] [--json]",
    );
    await handleSandboxCat(
      sessionId,
      path,
      opts as Parameters<typeof handleSandboxCat>[2],
      writer,
    );
  },

  telemetry: async (rawArgs, node, writer) => {
    const { handleTelemetry } = await import("../commands/telemetry.js");
    const { operands } = parseArgs(node, rawArgs);
    handleTelemetry(operands[0], writer);
  },
};

/**
 * Run an inline-dispatchable CLI command's captured output. `name` is the
 * catalog name (bare, colon-joined, or `cli:`-prefixed — all are accepted;
 * the `cli:` disambiguation prefix and path are stripped identically here).
 */
export async function runInlineCliCommand(
  name: string,
  rawArgs: string,
  buildProgram?: () => Command,
): Promise<CliDispatchResult> {
  const path = splitPath(name);
  const key = path.join(":");
  const adapter = REGISTRY[key];
  if (!adapter) {
    return {
      ok: false,
      output: `"${name}" is not wired for inline execution.`,
    };
  }
  // Injected normally (ReplOptions.buildProgram); lazy-imported as a fallback
  // so this module keeps zero static edges to the composition root.
  const root = (buildProgram ?? (await import("../program.js")).buildProgram)();
  const node = findCommandNode(root, path);
  if (!node) {
    return { ok: false, output: `Could not resolve CLI command "${name}".` };
  }
  const { writer, output } = captureWriter();
  try {
    await adapter(rawArgs, node, writer);
    const text = output();
    return { ok: true, output: text.length > 0 ? text : "(no output)" };
  } catch (err) {
    if (err instanceof UsageError) {
      return { ok: false, output: err.message };
    }
    const already = output();
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, output: already.length > 0 ? already : message };
  }
}
