/**
 * The permission broker — the safety layer between the model and the host.
 *
 * Oxagen's coding tools (`write_file`, `edit_file`, `bash`) change the user's
 * files and run shell commands. `--readonly` only withholds them entirely, which
 * is useless for any unattended, shared, or CI run. This module is the gate that
 * every mutating tool call passes through first.
 *
 * It is deliberately framework-agnostic: the broker returns `allow` or `deny`,
 * and asking the human is a pluggable async {@link Approver} the REPL supplies.
 * Non-interactive callers (one-shot, CI) omit the approver and get the mode's
 * safe default, which is to deny.
 *
 * Decision order for a mutating call, most decisive first — see
 * {@link PermissionBroker.check}, which implements it in this order:
 *   1. A `settings.json` `permissions.deny` rule → deny. This wins over
 *      everything, `bypass` included.
 *   2. `bypass` mode → allow (the user explicitly opted out of the gate).
 *   3. Base decision, first match wins: a `settings.json` `permissions.allow`
 *      rule → allow; else the first matching session/project/user rule →
 *      allow | ask | deny; else the mode default (`acceptEdits` allows file
 *      changes and asks for shell; `ask` asks for everything).
 *   4. Safety escalations turn a base `allow` back into `ask`: a catastrophic
 *      command pattern, or a write/edit outside the workspace root.
 *   5. Resolve an `ask` through the approver; with no approver, deny.
 *   6. When the human answers with `remember`, persist the rule to
 *      `.oxagen/settings.json` so future sessions decide the same way.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonicalToolName,
  evaluateLocalPermission,
} from "../settings/permissions-gate.js";
import type { Permissions } from "../settings/schema.js";

/** The tools that can change the host. Read/search tools are never gated. */
export const MUTATING_TOOLS = ["write_file", "edit_file", "bash"] as const;
export type MutatingTool = (typeof MUTATING_TOOLS)[number];

export function isMutatingTool(name: string): name is MutatingTool {
  return (MUTATING_TOOLS as readonly string[]).includes(name);
}

/**
 * Session permission posture.
 * - `readonly`   — mutating tools are withheld entirely (enforced in buildTools).
 * - `ask`        — every mutating call is approved/denied (default).
 * - `acceptEdits`— file writes/edits auto-allowed; shell commands still ask.
 * - `bypass`     — everything allowed, no prompts (explicit, dangerous opt-out).
 */
export type PermissionMode = "readonly" | "ask" | "acceptEdits" | "bypass";

export type RuleDecision = "allow" | "ask" | "deny";

/**
 * A user/project rule. `tool` matches a tool name (or "*"); `pattern` is a glob
 * matched against the call's path (file tools) or the command string (bash).
 * Rules are evaluated in order — the first match wins.
 */
export interface PermissionRule {
  tool?: string;
  pattern?: string;
  decision: RuleDecision;
}

/** A normalized, tool-agnostic description of a single mutating call. */
export interface PermissionRequest {
  tool: MutatingTool;
  /** Resolved absolute path for file tools (undefined for bash). */
  path?: string;
  /** The shell command for bash (undefined for file tools). */
  command?: string;
  cwd: string;
}

/** What the broker hands the human when it must ask. */
export interface ApprovalRequest extends PermissionRequest {
  /** One-line, human-readable summary of what will happen. */
  summary: string;
  /** Why approval is required (denylist hit, outside workspace, mode policy). */
  reason: string;
}

export interface ApprovalResponse {
  decision: "allow" | "deny";
  /**
   * When true, the broker records a session rule so identical future calls are
   * auto-resolved the same way without re-prompting.
   */
  remember?: boolean;
}

export type Approver = (req: ApprovalRequest) => Promise<ApprovalResponse>;

export type PermissionDecision =
  | { decision: "allow"; reason: string }
  | { decision: "deny"; reason: string };

export interface BrokerOptions {
  mode: PermissionMode;
  cwd: string;
  /** Project/user rules, evaluated before mode defaults. */
  rules?: PermissionRule[];
  /**
   * The resolved `settings.json` `permissions` block (allow/deny in Claude Code
   * rule syntax, e.g. `Bash(*)`, `Bash(rm -rf*)`). Consulted before the session
   * mode: a `deny` match is absolute (honored first, no matter what) and an
   * `allow` match auto-approves without a prompt — the whole point of putting
   * `Bash(*)` in settings. Evaluated with the SAME matcher the non-interactive
   * gate uses (`evaluateLocalPermission`), so the two layers never disagree.
   */
  permissions?: Permissions;
  /** Interactive prompt. Absent ⇒ non-interactive (every `ask` becomes `deny`). */
  approver?: Approver;
}

/**
 * Commands that can irreversibly destroy data or compromise the machine. A match
 * never silently passes — it is forced to `ask` even under `acceptEdits`, so the
 * human always sees it. (In `bypass` mode the user has opted out entirely.)
 */
const DANGEROUS_COMMAND = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f|\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r/i, // rm -rf / -fr
  /\brm\s+-[a-z]*\s+\/(\s|$)/i, // rm -… /
  /\b(mkfs|fdisk|parted)\b/i,
  /\bdd\b[^|]*\bof=\/dev\//i,
  /[>|]\s*\/dev\/(sd|nvme|disk|hd)/i,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bchmod\s+-R\s+777\s+\//i,
  /\b(curl|wget)\b[^|&;]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, // curl … | sh
  /\bgit\s+push\b[^&;]*--force\b[^&;]*\b(origin\s+)?(main|master)\b/i,
  /\bsudo\s+rm\b/i,
  /\b(shutdown|reboot|halt)\b/i,
] as const;

function matchesDangerous(command: string): boolean {
  return DANGEROUS_COMMAND.some((re) => re.test(command));
}

/** Minimal glob → RegExp (mirrors the tools' matcher): `**` any, `*` segment, `?` one. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * The string a rule's `pattern` is tested against. File rules match the path
 * *relative to the workspace root* (so `src/**` works regardless of where the
 * repo lives); bash rules match the raw command string.
 */
function subjectOf(req: PermissionRequest, cwd: string): string {
  if (req.tool === "bash") return req.command ?? "";
  return req.path ? relative(cwd, req.path) : "";
}

/**
 * Does an in-memory rule (a remembered session rule, or one from `BrokerOptions.rules`)
 * cover this request?
 *
 * WARNING — a bash rule here matches by PREFIX, so a remembered `allow` for
 * `git log` also covers `git log && <anything>`. The same rule persisted to
 * `settings.json` is matched by {@link evaluateLocalPermission} as a literal
 * glob, which does NOT prefix-match. A remembered allow is therefore broader
 * for the rest of this session than it is on the next run.
 */
function ruleMatches(
  rule: PermissionRule,
  req: PermissionRequest,
  cwd: string,
): boolean {
  if (rule.tool && rule.tool !== "*" && rule.tool !== req.tool) return false;
  if (rule.pattern) {
    const subject = subjectOf(req, cwd);
    // A command rule matches as a prefix or a glob; a path rule as a glob.
    if (req.tool === "bash") {
      if (
        !subject.startsWith(rule.pattern) &&
        !globToRegExp(rule.pattern).test(subject)
      )
        return false;
    } else if (!globToRegExp(rule.pattern).test(subject)) {
      return false;
    }
  }
  return true;
}

/** True when an absolute path is not inside (or equal to) the workspace root. */
export function isOutsideWorkspace(cwd: string, absPath: string): boolean {
  const rel = relative(resolve(cwd), resolve(absPath));
  return rel === ".." || rel.startsWith(".." + "/") || isAbsolute(rel);
}

function summarize(req: PermissionRequest): string {
  if (req.tool === "bash") return `Run: ${req.command ?? ""}`;
  const verb = req.tool === "write_file" ? "Write" : "Edit";
  const shown = req.path
    ? relative(req.cwd, req.path) || req.path
    : "(unknown path)";
  return `${verb} ${shown}`;
}

/**
 * The broker. Stateful only in that it accumulates session rules the human
 * chooses to "remember"; everything else is a pure function of the request and
 * the configured rules/mode.
 */
export class PermissionBroker {
  private mode: PermissionMode;
  private readonly cwd: string;
  private readonly approver?: Approver;
  private readonly baseRules: PermissionRule[];
  private readonly sessionRules: PermissionRule[] = [];
  private readonly permissions?: Permissions;

  constructor(opts: BrokerOptions) {
    this.mode = opts.mode;
    this.cwd = resolve(opts.cwd);
    this.approver = opts.approver;
    this.baseRules = opts.rules ?? [];
    this.permissions = opts.permissions;
  }

  get currentMode(): PermissionMode {
    return this.mode;
  }

  /** Switch posture mid-session (drives the REPL `/mode` command). */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Rules in precedence order: remembered session rules first, then configured. */
  private rules(): PermissionRule[] {
    return [...this.sessionRules, ...this.baseRules];
  }

  /** Record a rule so an identical future call resolves the same way silently. */
  private remember(req: PermissionRequest, decision: "allow" | "deny"): void {
    const pattern =
      req.tool === "bash"
        ? (req.command ?? "")
        : req.path
          ? relative(this.cwd, req.path)
          : undefined;
    const rule: PermissionRule = { tool: req.tool, pattern, decision };
    this.sessionRules.unshift(rule);
    // Persist to settings.json for future sessions
    this.persistRule(rule);
  }

  /** Persist a permission rule to settings.json. */
  private persistRule(rule: PermissionRule): void {
    const settingsPath = resolve(this.cwd, ".oxagen", "settings.json");
    let settings: Record<string, unknown> = {};

    try {
      if (existsSync(settingsPath)) {
        const content = readFileSync(settingsPath, "utf8");
        settings = JSON.parse(content) as Record<string, unknown>;
      }
    } catch (err) {
      // A corrupted settings file shouldn't block remembering a rule — start
      // fresh — but warn under OXAGEN_DEBUG, since silently discarding the
      // existing settings (and overwriting them below) is otherwise invisible.
      settings = {};
      if (process.env["OXAGEN_DEBUG"])
        process.stderr.write(
          `[permissions] could not read ${settingsPath}, starting fresh: ${err instanceof Error ? err.message : String(err)}\n`,
        );
    }

    const permissions = (settings.permissions as Record<string, unknown>) ?? {};
    const ruleStr = ruleToString(rule);

    // Add to allow or deny list
    if (rule.decision === "allow") {
      const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
      if (!allow.includes(ruleStr)) {
        allow.push(ruleStr);
        permissions.allow = allow;
      }
    } else if (rule.decision === "deny") {
      const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
      if (!deny.includes(ruleStr)) {
        deny.push(ruleStr);
        permissions.deny = deny;
      }
    }

    settings.permissions = permissions;
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(settings, null, 2) + "\n",
      "utf8",
    );
  }

  /**
   * Consult the `settings.json` `permissions` allow/deny lists for this request,
   * reusing the exact matcher the non-interactive gate uses so the two layers
   * never disagree. Returns `"deny"`/`"allow"` ONLY for an explicit rule match;
   * `"none"` when nothing matched (or no permissions are configured), so the
   * caller falls back to the session mode. Within `evaluateLocalPermission`,
   * deny is evaluated before allow — a deny always wins.
   */
  private settingsMatch(req: PermissionRequest): "allow" | "deny" | "none" {
    if (!this.permissions) return "none";
    const input =
      req.tool === "bash"
        ? { command: req.command ?? "" }
        : { path: req.path ?? "" };
    const result = evaluateLocalPermission(req.tool, input, this.permissions);
    // A decision with no `rule` came from `defaultMode`, not an explicit
    // allow/deny entry — leave that to the session mode below.
    if (!result.rule) return "none";
    return result.decision;
  }

  /**
   * Decide whether a mutating call may proceed. Never throws; an absent approver
   * on an `ask` resolves to `deny` (fail closed). Returns the decision plus a
   * human-readable reason (surfaced in the trace / tool result).
   */
  async check(req: PermissionRequest): Promise<PermissionDecision> {
    // 1. settings.json allow/deny (Claude Code rule syntax) — evaluated FIRST,
    //    ahead of the session mode and even ahead of `bypass`, so a `deny` entry
    //    is truly honored "no matter what": `Bash(*)` in `allow` plus
    //    `Bash(rm -rf*)` in `deny` still blocks `rm -rf`. An explicit `allow`
    //    match auto-approves without a prompt. `evaluateLocalPermission` already
    //    checks deny before allow, so deny wins within the settings block too.
    //    Only an EXPLICIT rule match steers the broker — a `defaultMode`
    //    fallthrough (no matching rule) is ignored so it never shadows the mode.
    const settings = this.settingsMatch(req);
    if (settings === "deny") {
      return {
        decision: "deny",
        reason: "denied by a settings.json deny rule",
      };
    }

    // 2. Explicit opt-out — the user has accepted full responsibility. (A
    //    settings deny above still wins; a settings allow is redundant here.)
    if (this.mode === "bypass")
      return { decision: "allow", reason: "bypass mode" };

    // 3. Base decision: a settings allow, else the first matching rule, else the
    //    mode default.
    let decision: RuleDecision;
    let reason: string;
    const rule = this.rules().find((r) => ruleMatches(r, req, this.cwd));
    if (settings === "allow") {
      decision = "allow";
      reason = "allowed by a settings.json allow rule";
    } else if (rule) {
      decision = rule.decision;
      reason = `matched ${rule.decision} rule`;
    } else if (this.mode === "acceptEdits" && req.tool !== "bash") {
      decision = "allow";
      reason = "acceptEdits: file change auto-approved";
    } else {
      decision = "ask";
      reason =
        this.mode === "acceptEdits"
          ? "shell command needs approval"
          : "approval required";
    }

    // 4. Safety escalations downgrade an `allow` to `ask` so a catastrophic
    //    command or a write outside the workspace is never run silently — even
    //    when a broad allow rule would otherwise pass it. An explicit `deny`
    //    still denies; bypass already returned above.
    if (decision === "allow") {
      if (req.tool === "bash" && req.command && matchesDangerous(req.command)) {
        decision = "ask";
        reason = "command matches a dangerous pattern";
      } else if (
        req.tool !== "bash" &&
        req.path &&
        isOutsideWorkspace(this.cwd, req.path)
      ) {
        decision = "ask";
        reason = "writes outside the workspace root";
      }
    }

    if (decision === "allow") return { decision: "allow", reason };
    if (decision === "deny") return { decision: "deny", reason };
    return this.ask(req, reason);
  }

  private async ask(
    req: PermissionRequest,
    reason: string,
  ): Promise<PermissionDecision> {
    if (!this.approver) {
      // Fail closed: no human available to approve.
      return { decision: "deny", reason: `${reason} (no approver — denied)` };
    }
    const response = await this.approver({
      ...req,
      summary: summarize(req),
      reason,
    });
    if (response.remember) this.remember(req, response.decision);
    return {
      decision: response.decision,
      reason:
        response.decision === "allow"
          ? `approved (${reason})`
          : `denied by user (${reason})`,
    };
  }
}

/** Map a CLI flag set to a {@link PermissionMode}. `readonly` wins; then bypass. */
export function resolveMode(opts: {
  readOnly?: boolean;
  acceptEdits?: boolean;
  bypass?: boolean;
}): PermissionMode {
  if (opts.readOnly) return "readonly";
  if (opts.bypass) return "bypass";
  if (opts.acceptEdits) return "acceptEdits";
  return "ask";
}

/** Accepted spellings for the `--mode` flag and the `/mode` command. */
const MODE_ALIASES: Record<string, PermissionMode> = {
  ask: "ask",
  "auto-edit": "acceptEdits",
  "accept-edits": "acceptEdits",
  acceptedits: "acceptEdits",
  bypass: "bypass",
  readonly: "readonly",
  "read-only": "readonly",
};

/** Parse a user-supplied mode string to a {@link PermissionMode} (or undefined). */
export function parseModeArg(s: string): PermissionMode | undefined {
  return MODE_ALIASES[s.trim().toLowerCase()];
}

/**
 * The settings.json rule string that {@link PermissionBroker.remember} would
 * persist for a given approval — e.g. `Edit(src/foo.ts)`, `Bash(pnpm build)`.
 * Exported so the REPL can tell the user exactly what was written to
 * `.oxagen/settings.json` when they choose "allow + remember".
 */
export function persistedRuleString(
  req: PermissionRequest,
  decision: "allow" | "deny",
  cwd: string,
): string {
  const pattern =
    req.tool === "bash"
      ? (req.command ?? "")
      : req.path
        ? relative(resolve(cwd), req.path)
        : undefined;
  return ruleToString({ tool: req.tool, pattern, decision });
}

/**
 * Convert a PermissionRule to the settings.json string format (e.g. "Edit(src/**)"
 * or "Bash(rm*)"). The tool is rendered as its CANONICAL permission name
 * (`write_file`→`Write`, `edit_file`→`Edit`, `bash`→`Bash`) — the exact token the
 * gate matches against. A naive capitalization would emit `Write_file`/`Edit_file`,
 * which the gate can never match, so a remembered "allow" rule would silently
 * never take effect.
 */
export function ruleToString(rule: PermissionRule): string {
  if (!rule.tool) return rule.pattern ?? "*";
  const toolDisplay = canonicalToolName(rule.tool);
  if (!rule.pattern) return toolDisplay;
  return `${toolDisplay}(${rule.pattern})`;
}

/** Build a normalized {@link PermissionRequest} from a raw tool call. */
export function toRequest(
  tool: string,
  input: unknown,
  cwd: string,
): PermissionRequest | null {
  if (!isMutatingTool(tool)) return null;
  const obj = (input ?? {}) as { path?: unknown; command?: unknown };
  if (tool === "bash") {
    return {
      tool,
      command: typeof obj.command === "string" ? obj.command : "",
      cwd,
    };
  }
  const p = typeof obj.path === "string" ? obj.path : "";
  const abs = p ? (isAbsolute(p) ? p : resolve(cwd, p)) : "";
  return { tool, path: abs, cwd };
}
