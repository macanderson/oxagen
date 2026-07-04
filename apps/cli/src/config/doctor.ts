/**
 * doctor.ts — `/config doctor` and `oxagen config doctor`: an offline,
 * deterministic scan of the four-tier config chain (repo ▸ workspace ▸ user ▸
 * org managed) that confirms which tiers are active, surfaces problems
 * (parse errors, values silently overridden by a more authoritative tier,
 * env vars shadowing file config), and recommends customizations the user
 * hasn't taken advantage of yet.
 *
 * Pure with respect to the process: everything is derived from
 * resolveWorkspaceConfig plus an injectable `env` snapshot, so tests can run
 * it against fixture scope files without touching the real HOME or process
 * env. No network, no writes.
 */
import { resolveWorkspaceConfig, CONFIG_SCOPE_ORDER, type ResolveWorkspaceConfigOptions } from "./resolve.js";
import type { ConfigScope, WorkspaceConfig } from "./schema.js";

export type DoctorSeverity = "ok" | "info" | "warn" | "error";

export interface DoctorFinding {
  severity: DoctorSeverity;
  title: string;
  detail?: string;
  /** Concrete next action — a command or panel gesture. */
  fix?: string;
}

export interface DoctorTier {
  scope: ConfigScope;
  path: string;
  present: boolean;
  error?: string;
}

export interface DoctorReport {
  /** The tier chain, most-specific first (repo ▸ workspace ▸ user ▸ org). */
  tiers: DoctorTier[];
  findings: DoctorFinding[];
}

export interface DoctorOptions extends ResolveWorkspaceConfigOptions {
  /** Env snapshot to scan for file-config shadowing. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/**
 * Env vars that silently take precedence over file config for the session.
 * Not exhaustive of every OXAGEN_* var — just the ones that shadow values a
 * user would otherwise expect their config files to control.
 */
const SHADOWING_ENV_VARS = [
  "OXAGEN_MODEL",
  "OXAGEN_EFFORT",
  "OXAGEN_API_TOKEN",
  "OXAGEN_API_URL",
  "OXAGEN_CLI_MOTION",
  "OXAGEN_CLI_MOUSE",
  "OXAGEN_TELEMETRY",
] as const;

/** Dotted leaf paths a single scope file sets (arrays are leaves; meta keys skipped). */
export function flattenScopePaths(config: WorkspaceConfig): string[] {
  const skip = new Set(["$schema", "version", "locked", "consolidated"]);
  const out: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) return;
      for (const [k, v] of entries) {
        if (path === "" && skip.has(k)) continue;
        if (v !== undefined) walk(v, path === "" ? k : `${path}.${k}`);
      }
      return;
    }
    if (path !== "") out.push(path);
  };
  walk(config, "");
  return out;
}

/** Run every check and assemble the report. */
export function runConfigDoctor(cwd: string, opts: DoctorOptions = {}): DoctorReport {
  const env = opts.env ?? process.env;
  const resolved = resolveWorkspaceConfig(cwd, { ...opts, noCache: true });
  const { config, scopes, provenance } = resolved;
  const findings: DoctorFinding[] = [];

  // ── Tier chain (the confirmation the user asked for) ──
  const byScope = new Map(scopes.map((s) => [s.scope, s]));
  const tiers: DoctorTier[] = [...CONFIG_SCOPE_ORDER]
    .reverse() // repo ▸ workspace ▸ user ▸ org — most specific first
    .map((scope) => {
      const s = byScope.get(scope)!;
      return { scope, path: s.path, present: s.config !== undefined || s.error !== undefined, error: s.error };
    });

  // ── Errors: unparseable / invalid scope files ──
  for (const tier of tiers) {
    if (tier.error) {
      findings.push({
        severity: "error",
        title: `${tier.scope} config is invalid and is being ignored`,
        detail: `${tier.path}: ${tier.error}`,
        fix: `Fix the file, then verify with \`oxagen config lint\`.`,
      });
    }
  }

  // ── Governance: writable-tier values silently losing to a locked tier ──
  for (const s of scopes) {
    if (s.scope === "org" || !s.config) continue;
    for (const path of flattenScopePaths(s.config)) {
      const prov = provenance[path];
      if (prov && prov.locked && prov.scope !== s.scope) {
        findings.push({
          severity: "warn",
          title: `${path} in ${s.scope} scope is overridden`,
          detail: `The ${prov.scope} tier ${prov.reason === "managed" ? "(org managed.json, always enforced)" : `locked this path (${prov.reason})`} — your ${s.scope} value never takes effect.`,
          fix: `Remove it from ${s.path}, or ask an org admin if the ${prov.scope} value should change.`,
        });
      }
    }
  }

  // ── Env shadowing: session env beats file config silently ──
  const shadowing = SHADOWING_ENV_VARS.filter((v) => env[v] !== undefined && env[v] !== "");
  if (shadowing.length > 0) {
    findings.push({
      severity: "info",
      title: "Environment variables are overriding file config this session",
      detail: shadowing.join(", "),
      fix: "Unset them (or move the values into config) if that isn't intentional.",
    });
  }

  // ── Presence / linkage ──
  const workspaceTier = byScope.get("workspace")!;
  const anyLocal = workspaceTier.config !== undefined || byScope.get("repo")!.config !== undefined;
  if (!anyLocal) {
    findings.push({
      severity: "warn",
      title: "No project-level config (workspace.json / repo.json) in this directory",
      detail: "Agents fall back to user/org defaults only — no repo rules are being applied.",
      fix: "Run `oxagen init` to link the workspace, or `oxagen config init` for a bare starter file.",
    });
  } else if (workspaceTier.config && !workspaceTier.config.workspaceSlug) {
    findings.push({
      severity: "info",
      title: "workspace.json isn't linked to a platform workspace",
      fix: "Run `oxagen init` to link it (enables memory recall + graph sync).",
    });
  }
  if (!byScope.get("org")!.config) {
    findings.push({
      severity: "info",
      title: "No org-managed settings on this machine",
      detail: "~/.oxagen/managed.json is absent — nothing is being enforced org-wide yet.",
      fix: "Run `oxagen config pull` once your organization provisions managed settings.",
    });
  }
  if (!byScope.get("user")!.config) {
    findings.push({
      severity: "info",
      title: "No personal defaults (~/.oxagen/user.json)",
      detail: "Preferences you set at user scope apply across every repo you work in.",
      fix: "`oxagen config init --scope user`, then set e.g. vcs.commit.convention once for all projects.",
    });
  }

  // ── Customization recommendations ──
  if (anyLocal) {
    if (!config.vision?.statement) {
      findings.push({
        severity: "info",
        title: "No vision statement set",
        detail: "A one-line vision anchors agent decisions to your product goals.",
        fix: "/config → highlight vision.statement → e to set it.",
      });
    }
    const cmds = config.commands ?? {};
    const declared = ["dev", "build", "test", "lint", "typecheck"].filter(
      (k) => (cmds as Record<string, unknown>)[k] !== undefined,
    );
    if (declared.length === 0) {
      findings.push({
        severity: "info",
        title: "No project commands declared (dev/build/test/lint/typecheck)",
        detail: "Declared commands stop agents from guessing how to run your project.",
        fix: '`oxagen config set commands.test \'[{"run":"pnpm test"}]\'`',
      });
    }
    if (!config.languages || Object.keys(config.languages).length === 0) {
      findings.push({
        severity: "info",
        title: "No per-language rules or conventions",
        detail: "Language rules (enforced or advisory) travel with the repo and steer every agent.",
        fix: '`oxagen config add typescript rule "no any — use unknown + narrowing"`',
      });
    }
    if (!config.consolidated && config.sources) {
      findings.push({
        severity: "info",
        title: "Sources are declared but the consolidated index hasn't been built",
        fix: "Run `oxagen config build`.",
      });
    }
  }

  if (findings.length === 0) {
    findings.push({ severity: "ok", title: "Configuration looks healthy — no findings." });
  }

  return { tiers, findings };
}

const SEVERITY_GLYPH: Record<DoctorSeverity, string> = {
  ok: "✓",
  info: "ℹ",
  warn: "⚠",
  error: "✗",
};

const SEVERITY_RANK: Record<DoctorSeverity, number> = { error: 0, warn: 1, info: 2, ok: 3 };

/** Render the report as the plain-text block /config doctor pushes into the transcript. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("Config doctor — tier chain (most specific wins; locked/org always wins):");
  for (const tier of report.tiers) {
    const status = tier.error ? "INVALID" : tier.present ? "active" : "absent";
    const label = tier.scope === "org" ? "org (managed, enforced)" : tier.scope;
    lines.push(`  ${tier.error ? "✗" : tier.present ? "●" : "○"} ${label.padEnd(24)} ${status.padEnd(8)} ${tier.path}`);
  }
  lines.push("");
  const ordered = [...report.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  for (const f of ordered) {
    lines.push(`${SEVERITY_GLYPH[f.severity]} ${f.title}`);
    if (f.detail) lines.push(`    ${f.detail}`);
    if (f.fix) lines.push(`    → ${f.fix}`);
  }
  const counts = report.findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const summary = (["error", "warn", "info"] as const)
    .filter((s) => counts[s])
    .map((s) => `${counts[s]} ${s}${counts[s]! > 1 && s !== "info" ? "s" : ""}`)
    .join(" · ");
  if (summary) {
    lines.push("");
    lines.push(summary);
  }
  return lines.join("\n");
}
