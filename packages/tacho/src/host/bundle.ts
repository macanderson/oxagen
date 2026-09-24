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

function toolNameMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true;
  if (TOOL_SYNONYMS[ruleTool] === toolName) return true;
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
  if (isShellTool(toolName)) {
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
  // A tool declaration is read only from a verified bundle. An unverified one
  // could declare Bash read-only and walk it past every check below.
  const declared = !input.bundleVerified
    ? undefined
    : (bundle.tools[toolName] ??
      (TOOL_SYNONYMS[toolName] !== undefined
        ? bundle.tools[TOOL_SYNONYMS[toolName] as string]
        : undefined));
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
  );
  if (ask !== undefined) {
    return {
      decision: bundle.mode === "observe" ? "allow" : "ask",
      evaluated: "ask",
      source: "bundle",
      rule: ask,
      reason_code: "rule_ask",
      reason: `Oxagen policy rule ${ask} requires a permission decision.`,
      ...base,
      stale,
    };
  }

  // 5. Allow rules.
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
