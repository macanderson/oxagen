/**
 * settings command — inspect and edit the unified `settings.json`.
 *
 *   oxagen settings                 Show the merged settings + where each scope lives
 *   oxagen settings path            List the three scope files and their status
 *   oxagen settings get <key>       Print a value (dotted, e.g. permissions.defaultMode)
 *   oxagen settings set <key> <val> Write a value (model | apiUrl | env.NAME)
 *   oxagen settings validate        Validate every scope file against the schema
 *   oxagen settings init            Write a documented starter file (project scope)
 *
 * `set` / `init` target a single scope (default: project) so the user/project/
 * local layering stays meaningful.
 *
 * Every handler accepts an optional resolution context (cwd / userSettingsPath)
 * so the command is exercisable in tests without touching the real `~/.config`.
 *
 * Output discipline (ADR-023 §4): each handler routes through `createOutput`.
 * The command's RESULT goes to stdout via `out.data` — one single-line JSON
 * value under `--json`, the human view otherwise; progress/caveats go to stderr
 * via `out.info`/`out.warn`; failures are uniform stderr error lines (exit 2 for
 * a bad scope argument, exit 1 for a write failure). `--json` rides on the
 * existing `ctx` arg (`ctx.json`) rather than a new positional, so the REPL
 * cli-bridge's `(ctx, writer)` call sites and the trailing `writer` param are
 * untouched. NOTE: program.ts does not yet declare a `--json` option on these
 * subcommands, so json mode is not reachable from the shell until it passes
 * `{ json: opts.json }` in the ctx arg — see the report.
 */
import { existsSync } from "node:fs";
import {
  loadSettings,
  getScopePaths,
  writeSettingsValue,
  writeStarterSettings,
  envVarForSettingsKey,
  shellShadowsSettingsKey,
  type SettingsScope,
  type OxagenSettings,
  type ResolveSettingsOptions,
} from "../settings/index.js";
import { createOutput } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

const SCOPES: SettingsScope[] = ["user", "project", "local"];

/**
 * Resolution context shared by every handler (paths come from here in tests).
 * `json` opts the handler into machine output (ADR-023 §4) — it rides here,
 * rather than as a new positional, so the REPL bridge's `(ctx, writer)` calls
 * and the trailing `writer` param stay exactly where they are.
 */
export type SettingsCtx = Pick<
  ResolveSettingsOptions,
  "cwd" | "userSettingsPath" | "projectDirName"
> & {
  /** `--json`: emit one single-line JSON value on stdout. */
  json?: boolean;
};

function isScope(value: string): value is SettingsScope {
  return (SCOPES as string[]).includes(value);
}

/** Navigate a dotted path (e.g. "permissions.defaultMode") into the settings. */
function getByPath(settings: OxagenSettings, key: string): unknown {
  let cur: unknown = settings;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

interface ScopeSummary {
  scope: SettingsScope;
  path: string;
  ok: boolean;
  error: string | null;
}

export function settingsShow(
  ctx: SettingsCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const { settings, scopes } = loadSettings({ ...ctx, noCache: true });
  const summaries: ScopeSummary[] = scopes
    .filter((s) => s.settings || s.error)
    .map((s) => ({
      scope: s.scope,
      path: s.path,
      ok: !s.error,
      error: s.error ?? null,
    }));
  out.data({ settings, scopes: summaries }, () => {
    const lines = [
      "Effective settings (merged user → project → local):",
      "",
      JSON.stringify(settings, null, 2),
      "",
      "Scopes:",
    ];
    if (summaries.length === 0) {
      lines.push("  (no settings files found — run `oxagen settings init`)");
    }
    for (const s of summaries) {
      const status = s.ok ? "ok" : `⚠ ${s.error}`;
      lines.push(`  ${s.scope.padEnd(8)} ${s.path}  [${status}]`);
    }
    return lines.join("\n");
  });
}

interface ScopePathInfo {
  scope: SettingsScope;
  path: string;
  exists: boolean;
}

export function settingsPath(
  ctx: SettingsCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const paths = getScopePaths(ctx);
  const infos: ScopePathInfo[] = SCOPES.map((scope) => ({
    scope,
    path: paths[scope],
    exists: existsSync(paths[scope]),
  }));
  out.data(infos, () =>
    [
      "Settings scope files (lowest → highest precedence):",
      "",
      ...infos.map(
        (i) =>
          `  ${i.scope.padEnd(8)} ${i.path}  ${i.exists ? "(exists)" : "(absent)"}`,
      ),
    ].join("\n"),
  );
}

export function settingsGet(
  key: string,
  ctx: SettingsCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const { settings } = loadSettings({ ...ctx, noCache: true });
  const raw = getByPath(settings, key);
  const present = raw !== undefined;
  out.data(
    { key, value: present ? raw : null, present },
    () =>
      `${key}: ${present ? (typeof raw === "string" ? raw : JSON.stringify(raw)) : "(not set)"}`,
  );
}

export function settingsSet(
  key: string,
  value: string,
  scopeArg?: string,
  ctx: SettingsCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const scope = scopeArg ?? "project";
  if (!isScope(scope)) {
    process.exitCode = 2;
    out.error(
      `Unknown scope "${scope}". Use one of: ${SCOPES.join(", ")}`,
      "usage",
    );
    return;
  }
  let path: string;
  try {
    path = writeSettingsValue({ ...ctx, scope, key, value });
  } catch (err) {
    out.error(err, "error");
    return;
  }
  out.data(
    { key, value, scope, path },
    () => `✓ ${key} = ${value}  (${scope}: ${path})`,
  );
  if (shellShadowsSettingsKey(key)) {
    const envVar = envVarForSettingsKey(key);
    out.warn(
      `  Note: shell value wins until you unset ${envVar} — it is already exported in this shell, ` +
        `and shell env always beats settings.json (see runtime.ts's projection gate).`,
    );
  }
}

interface ScopeValidation {
  scope: SettingsScope;
  path: string;
  ok: boolean;
  error: string | null;
}

export function settingsValidate(
  ctx: SettingsCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const { scopes } = loadSettings({ ...ctx, noCache: true });
  const results: ScopeValidation[] = scopes
    .filter((s) => s.settings || s.error) // absent file — nothing to validate
    .map((s) => ({
      scope: s.scope,
      path: s.path,
      ok: !s.error,
      error: s.error ?? null,
    }));
  const ok = results.every((r) => r.ok);
  if (!ok) process.exitCode = 1;
  out.data({ ok, checked: results.length, results }, () => {
    if (results.length === 0) return "No settings files found.";
    return results
      .map((r) =>
        r.ok
          ? `✓ ${r.scope} (${r.path})`
          : `✗ ${r.scope} (${r.path}): ${r.error}`,
      )
      .join("\n");
  });
}

export function settingsInit(
  scopeArg?: string,
  ctx: SettingsCtx = {},
  writer: CommandWriter = stdoutWriter,
): void {
  const out = createOutput({ json: ctx.json }, writer);
  const scope = scopeArg ?? "project";
  if (!isScope(scope)) {
    process.exitCode = 2;
    out.error(
      `Unknown scope "${scope}". Use one of: ${SCOPES.join(", ")}`,
      "usage",
    );
    return;
  }
  const { path, created } = writeStarterSettings({ ...ctx, scope });
  out.data({ path, created }, () =>
    created
      ? `✓ Wrote starter settings to ${path}\n  Edit it to add permissions, hooks, env, and MCP servers.`
      : `${path} already exists — left untouched.`,
  );
}
