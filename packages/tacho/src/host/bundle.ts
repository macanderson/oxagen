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
import { jcs, type JsonValue } from "../digest";
import { classifyTool } from "../claude-code/tools";
import type { DenyGeneration, PolicyBundle } from "../wire";
import { keyIdForPublicKey } from "./key-id";

export type PolicyDecisionValue = "allow" | "deny" | "ask" | "defer";

export interface BundleVerification {
  ok: boolean;
  reason?: string;
}

/** Verify a bundle against the enrollment's public key; what the host does offline. */
export function verifyBundle(
  bundle: PolicyBundle,
  publicKeyPem: string,
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
    return ok ? { ok } : { ok, reason: "signature does not verify" };
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
  const open = raw.indexOf("(");
  if (open === -1 || !raw.endsWith(")")) return { raw, tool: raw.trim() };
  return {
    raw,
    tool: raw.slice(0, open).trim(),
    spec: raw.slice(open + 1, -1),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** A shell-style glob: `**` crosses separators, `*` and `?` do not. */
export function globToRegex(glob: string, anchored = true): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (glob[i + 1] === "/") i += 1;
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

function candidatePaths(
  path: string,
  cwd: string | undefined,
  home: string | undefined,
): string[] {
  const out = [path];
  if (cwd !== undefined && path.startsWith(`${cwd}/`)) {
    out.push(path.slice(cwd.length + 1));
  }
  if (home !== undefined && path.startsWith(`${home}/`)) {
    out.push(`~/${path.slice(home.length + 1)}`);
  }
  return out;
}

function pathMatches(
  spec: string,
  path: string,
  cwd: string | undefined,
  home: string | undefined,
): boolean {
  const pattern = spec.startsWith("//") ? spec.slice(1) : spec;
  const regex = globToRegex(pattern);
  return candidatePaths(path, cwd, home).some((candidate) =>
    regex.test(candidate),
  );
}

function toolNameMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true;
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
}

/** Does a rule match this tool call? */
export function ruleMatches(
  rule: ParsedRule,
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  context: MatchContext = {},
): boolean {
  if (!toolNameMatches(rule.tool, toolName)) return false;
  if (rule.spec === undefined) return true;
  const input = toolInput ?? {};
  const text = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;
  if (toolName === "Bash") {
    const command = text("command");
    return command !== undefined && commandMatches(rule.spec, command);
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
    return pathMatches(rule.spec, path, context.cwd, context.home);
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
  /** Verified before evaluation; an unverified bundle is treated as absent. */
  bundleVerified: boolean;
  toolName: string;
  toolInput?: Record<string, unknown>;
  hostStatus: PolicyBundle["host_status"];
  session?: SessionControlState;
  /** The newest deny generation the host has seen, from any ingest response. */
  latestDenyGeneration?: DenyGeneration;
  /** Whether the control plane answered recently; decides how staleness resolves. */
  controlReachable: boolean;
  now: number;
  context?: MatchContext;
}

export interface Evaluation {
  /** What the hook answers. */
  decision: PolicyDecisionValue;
  /** What the rules said, before observe mode collapsed it to allow. */
  evaluated: PolicyDecisionValue;
  source: "bundle" | "harness" | "human";
  rule?: string;
  reason_code: string;
  reason: string;
  read_only: boolean;
  stale: boolean;
  risk_grade: "low" | "medium" | "high" | "critical";
  capability_id?: string;
  bundle_version: number;
  bundle_mode: PolicyBundle["mode"];
}

function isStale(
  bundle: PolicyBundle,
  latest: DenyGeneration | undefined,
  now: number,
): boolean {
  const expires = Date.parse(bundle.expires_at);
  if (Number.isFinite(expires) && expires < now) return true;
  if (latest === undefined) return false;
  return (
    latest.org > bundle.deny_generation.org ||
    latest.workspace > bundle.deny_generation.workspace
  );
}

function firstMatch(
  rules: readonly string[],
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  context: MatchContext | undefined,
): string | undefined {
  for (const raw of rules) {
    if (ruleMatches(parseRule(raw), toolName, toolInput, context)) return raw;
  }
  return undefined;
}

/**
 * The ordered `PreToolUse` evaluation. Operator state (suspended, paused,
 * cancelled) applies in both modes because it is control, not policy; in
 * observe mode the rule evaluation is recorded and the answer is allow.
 */
export function evaluatePreToolUse(input: EvaluationInput): Evaluation {
  const { bundle, toolName, toolInput } = input;
  const declared = bundle.tools[toolName];
  const classified = classifyTool(toolName, toolInput);
  const readOnly = declared?.read_only ?? !classified.tool_is_mutating;
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

  if (!input.bundleVerified) {
    if (bundle.mode === "observe") {
      return {
        decision: "allow",
        evaluated: "defer",
        source: "bundle",
        reason_code: "bundle_unverified",
        reason: "The cached bundle did not verify; observe mode allows.",
        ...base,
      };
    }
    return deny(
      "bundle_unverified",
      "The cached policy bundle did not verify and enforce mode fails closed.",
    );
  }

  // 2. Freshness.
  const stale = isStale(bundle, input.latestDenyGeneration, input.now);
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
  );
  if (denied !== undefined) {
    return {
      decision: bundle.mode === "observe" ? "allow" : "deny",
      evaluated: "deny",
      source: "bundle",
      rule: denied,
      reason_code: "rule_deny",
      reason: `Denied by Oxagen policy rule ${denied}.`,
      ...base,
      stale,
    };
  }

  // 4. Allow rules.
  const allowed = firstMatch(
    bundle.permissions.allow,
    toolName,
    toolInput,
    input.context,
  );
  if (allowed !== undefined) {
    return {
      decision: "allow",
      evaluated: "allow",
      source: "bundle",
      rule: allowed,
      reason_code: "rule_allow",
      reason: `Allowed by Oxagen policy rule ${allowed}.`,
      ...base,
      stale,
    };
  }

  // 5. Ask rules or no rule: fall through to Claude Code's own flow.
  const ask = firstMatch(
    bundle.permissions.ask,
    toolName,
    toolInput,
    input.context,
  );
  return {
    decision: bundle.mode === "observe" ? "allow" : "ask",
    evaluated: "ask",
    source: "bundle",
    ...(ask !== undefined ? { rule: ask } : {}),
    reason_code: ask !== undefined ? "rule_ask" : "no_rule",
    reason:
      ask !== undefined
        ? `Oxagen policy rule ${ask} requires a permission decision.`
        : "No Oxagen standing grant covers this tool; Claude Code's permission flow decides.",
    ...base,
    stale,
  };
}
