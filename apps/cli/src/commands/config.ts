/**
 * Config command — view or set local CLI configuration.
 *
 * Usage:
 *   oxagen config              Show all config
 *   oxagen config token        Show token (masked)
 *   oxagen config token sk-... Set token
 *   oxagen config model        Show model
 *   oxagen config model gpt-4  Set model
 *   oxagen config api-url      Show API URL
 *
 * The functions below this point are a SEPARATE surface: the structured,
 * multi-scope Oxagen Workspace Config (docs/specs/oxagen-workspace-config/design.md).
 * `handleConfig` above stays untouched — it's local CLI credentials/session
 * state (token/model/api-url/org/workspace), a different concept entirely.
 * The two coexist under one `oxagen config` Commander command because
 * Commander routes a first positional arg to a matching subcommand when one
 * exists (`get`/`set`/`add`/`remove`/`explain`/`build`/`lint`/`init`/`pull`,
 * registered in program.tsx) and falls back to this file's own `[key] [value]`
 * action otherwise — verified empirically; there is no name collision between
 * the legacy keys (token/model/api-url/org/workspace) and the new subcommands.
 */
import { existsSync } from "node:fs";
import { readConfig, writeConfig, type CliConfig } from "../lib/config.js";
import { userApiPostOrThrow } from "../lib/api.js";
import {
  resolveWorkspaceConfig,
  explain,
  getConfigScopePaths,
  assertWritableScope,
  setPath as writeSetPath,
  addLanguageItem,
  removeItem,
  writeConfigScopeDoc,
  writeConsolidated,
  buildConsolidatedIndex,
  CONFIG_SCOPES,
  LANGUAGE_ITEM_KINDS,
  type ConfigScope,
  type LanguageItem,
  type LanguageItemKind,
  type WorkspaceConfig,
  type ConfigWriteCtx,
  type BuildIndexOptions,
} from "../config/index.js";

const VALID_KEYS = ["token", "model", "api-url", "org", "workspace"] as const;
type ConfigKey = (typeof VALID_KEYS)[number];

function keyToConfigField(key: ConfigKey): keyof CliConfig {
  switch (key) {
    case "token": return "token";
    case "api-url": return "apiUrl";
    case "org": return "orgSlug";
    case "workspace": return "workspaceSlug";
    case "model": return "model" as keyof CliConfig;
  }
}

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return token.slice(0, 4) + "…" + token.slice(-4);
}

export async function handleConfig(key?: string, value?: string): Promise<void> {
  const config = readConfig();

  // No args: show all
  if (!key) {
    console.log("Configuration (~/.config/oxagen/config.json):\n");
    console.log(`  token:     ${config.token ? maskToken(config.token) : "(not set)"}`);
    console.log(`  api-url:   ${config.apiUrl ?? "https://api.oxagen.sh"}`);
    console.log(`  org:       ${config.orgSlug ?? "(not set)"}`);
    console.log(`  workspace: ${config.workspaceSlug ?? "(not set)"}`);
    console.log(`\nSet a value: oxagen config <key> <value>`);
    return;
  }

  if (!VALID_KEYS.includes(key as ConfigKey)) {
    console.error(`Unknown config key: "${key}"`);
    console.error(`Valid keys: ${VALID_KEYS.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const field = keyToConfigField(key as ConfigKey);

  // Get
  if (value === undefined) {
    const current = config[field];
    if (!current) {
      console.log(`${key}: (not set)`);
    } else if (key === "token") {
      console.log(`${key}: ${maskToken(current as string)}`);
    } else {
      console.log(`${key}: ${current}`);
    }
    return;
  }

  // Set
  writeConfig({ [field]: value });
  const display = key === "token" ? maskToken(value) : value;
  console.log(`✓ ${key} = ${display}`);
}

// ─────────────────────────────────────────────────────────────────────────
// Oxagen Workspace Config — the structured, governed CLAUDE.md replacement.
// `oxagen config init|get|set|add|remove|explain|build|lint|pull`
// (docs/specs/oxagen-workspace-config/design.md §7)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Resolution/write context shared by every handler below (paths come from here
 * in tests). Includes the indexer's test-injection seams (`userHomeDir` /
 * `userSettingsPath`) so `configBuild`/`configLint` — the two handlers that
 * call into `buildConsolidatedIndex` — can be pointed at a fixture "$HOME"
 * without touching the real one; other handlers simply ignore those fields.
 */
export type WorkspaceConfigCtx = ConfigWriteCtx & Pick<BuildIndexOptions, "userHomeDir" | "userSettingsPath">;

const DEFAULT_SCOPE: ConfigScope = "workspace";

function isConfigScope(value: string): value is ConfigScope {
  return (CONFIG_SCOPES as readonly string[]).includes(value);
}

function reportScopeError(scope: string): void {
  console.error(`Unknown scope "${scope}". Use one of: ${CONFIG_SCOPES.join(", ")}`);
  process.exitCode = 1;
}

function reportError(err: unknown): void {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

function getByPath(config: WorkspaceConfig, dottedPath: string): unknown {
  let cur: unknown = config;
  for (const part of dottedPath.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** `oxagen config init [--scope <s>]` — write a starter scope file (default: workspace). Never clobbers. */
export function configInit(scopeArg: string | undefined, ctx: WorkspaceConfigCtx = {}): void {
  const scope = scopeArg ?? DEFAULT_SCOPE;
  if (!isConfigScope(scope)) return reportScopeError(scope);
  try {
    // configInit writes via writeConfigScopeDoc directly (not one of write.ts's
    // scope-aware setters), so it must check writability itself.
    assertWritableScope(scope);
  } catch (err) {
    return reportError(err);
  }
  const cwd = ctx.cwd ?? process.cwd();
  const path = getConfigScopePaths(cwd, ctx)[scope];
  if (existsSync(path)) {
    console.log(`${path} already exists — left untouched.`);
    return;
  }
  try {
    writeConfigScopeDoc(path, { $schema: "https://schemas.oxagen.sh/workspace.json", version: 1 });
  } catch (err) {
    return reportError(err);
  }
  console.log(`✓ Wrote starter ${scope} config to ${path}`);
  console.log(`  Edit it with \`oxagen config set <path> <value> --scope ${scope}\` or \`oxagen config add <lang> <kind> "…"\`.`);
}

/** `oxagen config get <path>` — print the merged value + which scope it resolved from. */
export function configGet(dottedPath: string, ctx: WorkspaceConfigCtx = {}): void {
  const cwd = ctx.cwd ?? process.cwd();
  const { config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
  const value = getByPath(config, dottedPath);
  if (value === undefined) {
    console.log(`${dottedPath}: (not set)`);
    return;
  }
  const { scope } = explain(cwd, dottedPath, ctx);
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`${dottedPath}: ${rendered}${scope ? `  (${scope})` : ""}`);
}

/** `oxagen config set <path> <value> [--scope <s>]` — write one value to one scope file. */
export function configSet(
  dottedPath: string,
  value: string,
  scopeArg: string | undefined,
  ctx: WorkspaceConfigCtx = {},
): void {
  const scope = scopeArg ?? DEFAULT_SCOPE;
  if (!isConfigScope(scope)) return reportScopeError(scope);
  const cwd = ctx.cwd ?? process.cwd();
  const before = explain(cwd, dottedPath, ctx);
  try {
    const path = writeSetPath(scope, dottedPath, value, ctx);
    console.log(`✓ ${dottedPath} = ${value}  (${scope}: ${path})`);
    if (before.locked && before.scope && before.scope !== scope) {
      console.log(
        `  Note: ${before.reason} — this write may be overridden at resolve time. ` +
          `Run \`oxagen config explain ${dottedPath}\` to confirm.`,
      );
    }
  } catch (err) {
    reportError(err);
  }
}

export interface ConfigAddOptions {
  scope?: string;
  id?: string;
  doc?: string;
  enforced?: boolean;
  locked?: boolean;
  source?: string;
  confidence?: string;
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "item";
}

/** `oxagen config add <lang> <kind> "<text>" [--scope <s>] [--id <id>] [...]` — append a language item. */
export function configAdd(
  lang: string,
  kind: string,
  text: string,
  opts: ConfigAddOptions = {},
  ctx: WorkspaceConfigCtx = {},
): void {
  const scope = opts.scope ?? DEFAULT_SCOPE;
  if (!isConfigScope(scope)) return reportScopeError(scope);
  if (!(LANGUAGE_ITEM_KINDS as readonly string[]).includes(kind)) {
    console.error(`Unknown kind "${kind}". Use one of: ${LANGUAGE_ITEM_KINDS.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const id = opts.id ?? slugify(text);
  const item: LanguageItem = {
    id,
    kind: kind as LanguageItemKind,
    text,
    doc: opts.doc,
    enforced: opts.enforced,
    locked: opts.locked,
    origin: "manual",
    source: opts.source,
    confidence: opts.confidence !== undefined ? Number(opts.confidence) : undefined,
  };
  try {
    const path = addLanguageItem(scope, lang, item, ctx);
    console.log(`✓ Added ${kind} "${id}" to languages.${lang} (${scope}: ${path})`);
  } catch (err) {
    reportError(err);
  }
}

/** `oxagen config remove <id> [--scope <s>]` — remove a language item by id. */
export function configRemove(id: string, scopeArg: string | undefined, ctx: WorkspaceConfigCtx = {}): void {
  const scope = scopeArg ?? DEFAULT_SCOPE;
  if (!isConfigScope(scope)) return reportScopeError(scope);
  try {
    const result = removeItem(scope, id, ctx);
    if (result.removed) {
      const where = result.languages.map((l) => `languages.${l}`).join(", ");
      console.log(`✓ Removed "${id}" from ${where} (${scope}: ${result.path})`);
    } else {
      console.log(`"${id}" not found in ${scope} (${result.path}).`);
      process.exitCode = 1;
    }
  } catch (err) {
    reportError(err);
  }
}

/** `oxagen config explain <path>` — report which scope wins and why. */
export function configExplain(dottedPath: string, ctx: WorkspaceConfigCtx = {}): void {
  const cwd = ctx.cwd ?? process.cwd();
  const result = explain(cwd, dottedPath, ctx);
  console.log(`${dottedPath}: ${result.reason}`);
}

export interface ConfigBuildOptions {
  /** Best-effort live-connect to MCP servers to list their tools. Default off (fast, offline-safe). */
  liveMcp?: boolean;
  json?: boolean;
}

/** `oxagen config build [--live-mcp] [--json]` — scan `sources` and write the consolidated index. */
export async function configBuild(opts: ConfigBuildOptions = {}, ctx: WorkspaceConfigCtx = {}): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  let consolidated;
  try {
    consolidated = await buildConsolidatedIndex(cwd, { ...ctx, liveMcpTools: opts.liveMcp });
  } catch (err) {
    return reportError(err);
  }
  let path: string;
  try {
    path = writeConsolidated(consolidated, ctx);
  } catch (err) {
    return reportError(err);
  }
  if (opts.json) {
    console.log(JSON.stringify(consolidated, null, 2));
    return;
  }
  console.log(`✓ Built consolidated index → ${path}`);
  console.log(
    `  skills: ${consolidated.skills?.length ?? 0}  agents: ${consolidated.agents?.length ?? 0}  ` +
      `mcpServers: ${consolidated.mcpServers?.length ?? 0}  commands: ${consolidated.commands?.length ?? 0}  ` +
      `customTools: ${consolidated.customTools?.length ?? 0}`,
  );
  console.log(`  scanned ${consolidated.sourceFiles?.length ?? 0} source files`);
}

/** Diff two consolidated indexes by entry name, per category — used by `configLint`'s drift check. */
function diffConsolidated(
  stored: WorkspaceConfig["consolidated"],
  fresh: WorkspaceConfig["consolidated"],
): string[] {
  const drift: string[] = [];
  const categories = ["skills", "agents", "mcpServers", "commands", "customTools"] as const;
  for (const category of categories) {
    const beforeNames = new Set((stored?.[category] ?? []).map((i) => i.name));
    const afterNames = new Set((fresh?.[category] ?? []).map((i) => i.name));
    const added = [...afterNames].filter((n) => !beforeNames.has(n));
    const removed = [...beforeNames].filter((n) => !afterNames.has(n));
    if (added.length > 0) drift.push(`${category}: +${added.join(", +")}`);
    if (removed.length > 0) drift.push(`${category}: -${removed.join(", -")}`);
  }
  return drift;
}

/** `oxagen config lint` — validate every scope file against the schema + report `consolidated` drift. */
export async function configLint(ctx: WorkspaceConfigCtx = {}): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const { scopes, config } = resolveWorkspaceConfig(cwd, { ...ctx, noCache: true });
  let ok = true;
  let checked = 0;
  for (const s of scopes) {
    if (!s.config && !s.error) continue;
    checked++;
    if (s.error) {
      ok = false;
      console.error(`✗ ${s.scope} (${s.path}): ${s.error}`);
    } else {
      console.log(`✓ ${s.scope} (${s.path})`);
    }
  }
  if (checked === 0) console.log("No config files found. Run `oxagen config init`.");

  if (config.consolidated) {
    let fresh;
    try {
      fresh = await buildConsolidatedIndex(cwd, ctx); // liveMcpTools left off — lint stays fast/offline
    } catch (err) {
      ok = false;
      console.error(`✗ consolidated: could not re-scan sources: ${err instanceof Error ? err.message : String(err)}`);
      fresh = undefined;
    }
    if (fresh) {
      const drift = diffConsolidated(config.consolidated, fresh);
      if (drift.length === 0) {
        console.log("consolidated: up to date");
      } else {
        ok = false;
        console.log("consolidated: drift detected — run `oxagen config build` to refresh");
        for (const line of drift) console.log(`  ${line}`);
      }
    }
  }

  if (!ok) process.exitCode = 1;
}

interface ConfigPullResponse {
  userConfig?: WorkspaceConfig;
  managedConfig?: WorkspaceConfig;
}

/**
 * `oxagen config pull` — sync `user.json` (and org-provisioned `managed.json`)
 * from the platform (design.md §8, "like `env:pull`"). The endpoint doesn't
 * exist yet — this never blocks or throws to the caller; any failure (missing
 * endpoint, not logged in, network) prints a clear "not yet available" message.
 */
export async function configPull(ctx: WorkspaceConfigCtx = {}): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  let result: ConfigPullResponse;
  try {
    result = await userApiPostOrThrow<ConfigPullResponse>("config/pull", {});
  } catch (err) {
    console.log(
      "Config pull isn't available yet — the platform doesn't expose a config sync endpoint " +
        `(${err instanceof Error ? err.message : String(err)}). Edit ~/.oxagen/user.json directly for now.`,
    );
    return;
  }
  const paths = getConfigScopePaths(cwd, ctx);
  let pulled = 0;
  try {
    if (result.userConfig) {
      writeConfigScopeDoc(paths.user, result.userConfig as unknown as Record<string, unknown>);
      console.log(`✓ Pulled user config → ${paths.user}`);
      pulled++;
    }
    if (result.managedConfig) {
      writeConfigScopeDoc(paths.org, result.managedConfig as unknown as Record<string, unknown>);
      console.log(`✓ Pulled managed (org) config → ${paths.org}`);
      pulled++;
    }
  } catch (err) {
    return reportError(err);
  }
  if (pulled === 0) console.log("Nothing to pull — no user or managed config on the platform yet.");
}
