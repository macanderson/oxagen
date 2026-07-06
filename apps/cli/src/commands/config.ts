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
import { readConfig, writeConfig, getApiUrl, getToken, type CliConfig } from "../lib/config.js";
import { userApiPostOrThrow } from "../lib/api.js";
import { resolveModelId, resolveEffort, findModelMask, isReasoningEffort, EFFORT_LEVELS } from "../agent/model.js";
import { loadSettings } from "../settings/index.js";
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
  CONFIG_SCOPE_ORDER,
  LANGUAGE_ITEM_KINDS,
  RUNTIME_DEAD_KEYS,
  RUNTIME_DEAD_KEY_REDIRECT,
  type ConfigScope,
  type LanguageItem,
  type LanguageItemKind,
  type WorkspaceConfig,
  type ConfigWriteCtx,
  type BuildIndexOptions,
} from "../config/index.js";

// "effort" was omitted here historically even though `CliConfig`/store #2
// (~/.config/oxagen/config.json) has always had an `effort` field
// (`resolveEffort` in agent/model.ts reads it) — there was simply no CLI
// command to persist it, only the transient per-turn `--effort` flag. Added
// alongside item 5's dead-key redirect so `oxagen config effort <level>` (the
// redirect target for a mistaken `config set effort <level>`) is a real,
// working command rather than another dead end.
const VALID_KEYS = ["token", "model", "api-url", "org", "workspace", "effort"] as const;
type ConfigKey = (typeof VALID_KEYS)[number];

function keyToConfigField(key: ConfigKey): keyof CliConfig {
  switch (key) {
    case "token": return "token";
    case "api-url": return "apiUrl";
    case "org": return "orgSlug";
    case "workspace": return "workspaceSlug";
    case "model": return "model" as keyof CliConfig;
    case "effort": return "effort" as keyof CliConfig;
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
    console.log(`  effort:    ${config.effort ?? "(not set)"}`);
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
  if (field === "effort") {
    if (!isReasoningEffort(value)) {
      console.error(`Invalid effort "${value}". Valid: ${EFFORT_LEVELS.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    writeConfig({ effort: value });
  } else {
    writeConfig({ [field]: value } as Partial<CliConfig>);
  }
  const display = key === "token" ? maskToken(value) : value;
  console.log(`✓ ${key} = ${display}`);

  // Item 6: a model set here (store #2) can be permanently masked at runtime
  // by OXAGEN_MODEL — either exported directly in the shell, or projected
  // from settings.json by applySettingsToEnv (../settings/runtime.ts). Tell
  // the user right away, with exactly where the mask lives, instead of
  // leaving them to discover their new model is silently never used.
  if (key === "model") {
    const mask = findModelMask(value);
    if (mask) {
      console.log(
        `  Note: ${mask.source} currently resolves to "${mask.value}", which wins at runtime over this ` +
          `config.json value. Unset OXAGEN_MODEL, remove "model" from that settings file, or run ` +
          `\`oxagen settings set model ${value} --scope local\` to match — then \`oxagen config model\` will ` +
          `report the value that's actually in effect.`,
      );
    }
  }
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

/** The env var each runtime dead key resolves through at runtime (see the resolvers in agent/model.ts + lib/config.ts). */
const RUNTIME_KEY_ENV_VAR: Record<(typeof RUNTIME_DEAD_KEYS)[number], string> = {
  model: "OXAGEN_MODEL",
  apiUrl: "OXAGEN_API_URL",
  effort: "OXAGEN_EFFORT",
  token: "OXAGEN_API_TOKEN",
};

/**
 * Item 8b (split-brain get): `oxagen config get model` (this Workspace Config
 * surface) and `oxagen config model` (the legacy store #2 getter) read
 * DIFFERENT stores — and store #3 never had `model` in the first place (item
 * 5 now blocks it from ever being written there). Rather than pick one store
 * to read arbitrarily, print every store that could plausibly hold the value
 * — shell env, settings.json (model/apiUrl only), config.json (store #2) —
 * with the actual runtime-effective winner (via the same resolver the agent
 * loop uses) clearly marked, so there's no ambiguity about what wins.
 */
function printRuntimeKeyGet(key: (typeof RUNTIME_DEAD_KEYS)[number], ctx: WorkspaceConfigCtx): void {
  const cwd = ctx.cwd ?? process.cwd();
  const envVar = RUNTIME_KEY_ENV_VAR[key];
  const envValue = process.env[envVar];
  const config = readConfig();
  const configValue = config[key as keyof CliConfig] as string | undefined;
  const mask = (v: string | undefined): string => (v === undefined ? "(not set)" : key === "token" ? maskToken(v) : v);

  console.log(`${key} — resolved from EACH store (config get / config set never touch these — see \`oxagen config ${RUNTIME_DEAD_KEY_REDIRECT[key]}\`):`);
  console.log(`  shell/session env ${envVar}:  ${mask(envValue)}`);

  if (key === "model" || key === "apiUrl") {
    const { settings, scopes } = loadSettings({ cwd, userSettingsPath: ctx.userSettingsPath, noCache: true });
    const settingsValue = settings[key];
    const winner = [...scopes].reverse().find((s) => s.settings?.[key] !== undefined);
    console.log(`  settings.json${winner ? ` (${winner.scope}: ${winner.path})` : ""}:  ${mask(settingsValue)}`);
  }

  console.log(`  ~/.config/oxagen/config.json:  ${mask(configValue)}`);

  let effective: string | undefined;
  switch (key) {
    case "model": effective = resolveModelId(); break;
    case "apiUrl": effective = getApiUrl(); break;
    case "effort": effective = resolveEffort(); break;
    case "token": effective = getToken(); break;
  }
  console.log(`  → effective at runtime:  ${mask(effective)}`);
}

/** `oxagen config get <path>` — print the merged value + which scope it resolved from. */
export function configGet(dottedPath: string, ctx: WorkspaceConfigCtx = {}): void {
  if ((RUNTIME_DEAD_KEYS as readonly string[]).includes(dottedPath)) {
    printRuntimeKeyGet(dottedPath as (typeof RUNTIME_DEAD_KEYS)[number], ctx);
    return;
  }
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
  // Item 5 (dead-key writes): model/apiUrl/effort/token belong to store #2
  // (~/.config/oxagen/config.json) or settings.json, never to this Workspace
  // Config surface — nothing reads them back from workspace/user/repo/managed
  // config. Redirect instead of printing a confident "✓" for a write that
  // would be a silent no-op (schema.ts's superRefine also rejects these
  // defense-in-depth, but that produces a less actionable zod error).
  if ((RUNTIME_DEAD_KEYS as readonly string[]).includes(dottedPath)) {
    const redirect = RUNTIME_DEAD_KEY_REDIRECT[dottedPath as (typeof RUNTIME_DEAD_KEYS)[number]];
    console.error(
      `"${dottedPath}" is a CLI runtime setting, not a Workspace Config field — nothing reads it from ` +
        `workspace/user/repo/managed config, so this write would be silently ignored. ` +
        `Did you mean: oxagen config ${redirect} ${value}`,
    );
    process.exitCode = 1;
    return;
  }

  const scope = scopeArg ?? DEFAULT_SCOPE;
  if (!isConfigScope(scope)) return reportScopeError(scope);
  const cwd = ctx.cwd ?? process.cwd();
  const before = explain(cwd, dottedPath, ctx);
  try {
    const path = writeSetPath(scope, dottedPath, value, ctx);
    console.log(`✓ ${dottedPath} = ${value}  (${scope}: ${path})`);
    // Item 8a: warn whenever a DIFFERENT scope currently wins this path and
    // will keep winning after this write — either because it's governance-
    // locked (the original check) OR because it's simply a more-specific,
    // unlocked scope (e.g. writing to `user` while `workspace`/`repo` already
    // set the same path — CONFIG_SCOPE_ORDER puts those later/"more specific",
    // so they'd silently keep shadowing this write otherwise).
    if (before.scope && before.scope !== scope) {
      const specificity = (s: ConfigScope) => CONFIG_SCOPE_ORDER.indexOf(s);
      const stillWins = before.locked || specificity(before.scope) > specificity(scope);
      if (stillWins) {
        console.log(
          `  Note: ${before.reason} — this write may be overridden at resolve time. ` +
            `Run \`oxagen config explain ${dottedPath}\` to confirm.`,
        );
      }
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

/**
 * `oxagen config doctor` — scan the four-tier chain (repo ▸ workspace ▸ user ▸
 * org managed): confirm which tiers are active, flag invalid files, values
 * silently overridden by a locked tier, env shadowing, and recommend
 * customizations. Same engine as the REPL's `/config doctor`.
 */
export async function configDoctor(ctx: WorkspaceConfigCtx = {}): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const { runConfigDoctor, formatDoctorReport } = await import("../config/doctor.js");
  const report = runConfigDoctor(cwd, ctx);
  console.log(formatDoctorReport(report));
  if (report.findings.some((f) => f.severity === "error")) process.exitCode = 1;
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
