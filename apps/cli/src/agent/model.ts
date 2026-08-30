/**
 * Model resolution for the local agent loop.
 *
 * Models are passed to the AI SDK as plain Vercel AI Gateway slugs
 * (`vendor/model`), which the gateway resolves using `AI_GATEWAY_API_KEY`.
 *
 * Resolution order: `--model` / opts → `OXAGEN_MODEL` env → `model` in config →
 * the default below.
 */
import { readConfig } from "../lib/config.js";
import { loadSettings, type SettingsScope } from "../settings/index.js";
import { DEFAULT_CODING_MODEL } from "./model-catalog.js";

/**
 * Default coding model. Override per-call (`opts.model`), per-shell
 * (`OXAGEN_MODEL`), or persistently (`oxagen config model <slug>`).
 * If the gateway reports the slug as unknown, set a current one with
 * `oxagen config model <slug>` — gateway slugs drift over time.
 *
 * Resolves to the latest-GA balanced/Sonnet slug from the model catalog, the
 * single place that tracks "latest" per family.
 */
export const DEFAULT_MODEL = DEFAULT_CODING_MODEL;

export function resolveModelId(override?: string): string {
  return (
    override ??
    process.env["OXAGEN_MODEL"] ??
    readConfig().model ??
    DEFAULT_MODEL
  );
}

/**
 * The worker model the USER explicitly chose (`--model` / `/worker-model` →
 * opts, `OXAGEN_MODEL` env — which settings.json's `workerModel` projects
 * into at boot — or `oxagen config model`), or undefined when they chose
 * nothing. Same chain as {@link resolveModelId} MINUS the default: callers use
 * undefined to mean "auto" and let the engine's per-turn router pick the tier
 * (cheapest sufficient tier, with the precise safety floor for auth/billing/
 * security/migration/architecture work) instead of collapsing "no choice"
 * into a pinned default that defeats routing.
 */
export function explicitModelId(override?: string): string | undefined {
  return (
    override ?? process.env["OXAGEN_MODEL"] ?? readConfig().model ?? undefined
  );
}

export interface ModelMask {
  /** The value that actually wins at runtime (differs from what the caller is about to set). */
  value: string;
  /** Human-readable description of where the winning value lives. */
  source: string;
}

export interface FindModelMaskOptions {
  cwd?: string;
  /** Test-injection seam — see settings/resolve.ts's ResolveSettingsOptions. Real callers omit it. */
  userSettingsPath?: string;
  projectDirName?: string;
}

/**
 * Detect whether `newValue` (about to be written to store #2,
 * `~/.config/oxagen/config.json`, via `oxagen config model <x>`) would
 * actually take effect, or whether `OXAGEN_MODEL` — set directly in the shell,
 * or projected from `settings.json`'s `model` by `applySettingsToEnv`
 * (../settings/runtime.ts) — permanently masks it (`resolveModelId` above
 * checks `OXAGEN_MODEL` before ever consulting store #2). Returns `null` when
 * nothing would mask `newValue`. Best-effort/offline: reads settings files
 * fresh via `loadSettings`, never throws.
 */
export function findModelMask(
  newValue: string,
  opts: FindModelMaskOptions = {},
): ModelMask | null {
  const envValue = process.env["OXAGEN_MODEL"];
  if (envValue === undefined || envValue === "" || envValue === newValue)
    return null;

  const cwd = opts.cwd ?? process.cwd();
  const { settings, scopes } = loadSettings({
    cwd,
    userSettingsPath: opts.userSettingsPath,
    projectDirName: opts.projectDirName,
    noCache: true,
  });
  if (settings.model !== undefined && settings.model === envValue) {
    // The winning env value matches what settings.json resolves to — most
    // likely it got there via applySettingsToEnv's projection. Identify the
    // most-specific scope that actually declares `model` (local > project > user).
    const order: SettingsScope[] = ["local", "project", "user"];
    const winner =
      scopes.find(
        (s) => s.scope === order[0] && s.settings?.model !== undefined,
      ) ??
      scopes.find(
        (s) => s.scope === order[1] && s.settings?.model !== undefined,
      ) ??
      scopes.find(
        (s) => s.scope === order[2] && s.settings?.model !== undefined,
      );
    if (winner) {
      return {
        value: envValue,
        source: `${winner.scope} settings.json (${winner.path}), projected to OXAGEN_MODEL`,
      };
    }
    return {
      value: envValue,
      source: "settings.json, projected to OXAGEN_MODEL",
    };
  }
  return {
    value: envValue,
    source:
      "the OXAGEN_MODEL environment variable already exported in your shell",
  };
}

/**
 * Reasoning effort levels forwarded to models that support a thinking mode.
 * `xhigh`/`max` are the deepest Anthropic (Claude Fable) tiers; vendors without
 * them clamp to `high` server-side.
 */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof EFFORT_LEVELS)[number];

/** Type guard: is `s` a valid reasoning-effort level? */
export function isReasoningEffort(s: string): s is ReasoningEffort {
  return (EFFORT_LEVELS as readonly string[]).includes(s);
}

/**
 * Resolve the reasoning effort for a turn. Order: explicit override →
 * `OXAGEN_EFFORT` env → `effort` in config → undefined (let the model/server
 * default decide). Undefined is meaningful: it forwards no `reasoning_effort`,
 * so a model's own default governs.
 */
export function resolveEffort(override?: string): ReasoningEffort | undefined {
  const raw = override ?? process.env["OXAGEN_EFFORT"] ?? readConfig().effort;
  if (raw && isReasoningEffort(raw)) return raw;
  return undefined;
}
