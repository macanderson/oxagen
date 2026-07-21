import { z } from "zod";

// conditions.ts — pure condition-language evaluator for IAM grants and policies.
//
// A conditionsJsonb value is an arbitrary JSON object stored alongside a
// grant/policy row. This module defines the supported condition schema and
// provides a pure evaluator that is safe to call from the resolver without
// any I/O.
//
// Design rules (all preserved for security):
//   - Empty/absent conditions object   → true  (unconditional grant)
//   - Unknown condition key             → false (fail-closed; never silently ignore)
//   - Malformed value for a known key   → false (fail-closed)
//   - clientIp is null + ip condition   → false (fail-closed)
//   - Multiple condition keys            → AND  (all must pass)
//
// Supported condition keys (v1):
//   time_window   — allow only within a recurring time band (HH:MM–HH:MM in tz)
//   ip_ranges     — allow only when clientIp falls inside one of the listed CIDRs
//   resourceScope — agent RBAC resource-scope ceiling (graph labels/rel-types,
//                   MCP server:tool rules, skill slugs, subagent refs). See
//                   docs/specs/agent-rbac/spec.md §3.3. Structural validation
//                   only here — the resolver (resolve.ts) is what intersects
//                   and enforces the scope; this evaluator only rejects a
//                   malformed payload (fail-closed).
//
// Example conditionsJsonb:
// {
//   "time_window": { "tz": "America/New_York", "days": [1,2,3,4,5], "start": "09:00", "end": "17:00" },
//   "ip_ranges": ["10.0.0.0/8", "192.168.1.0/24"]
// }

// ── Condition schema types ─────────────────────────────────────────────────────

/**
 * A recurring time-window restriction.
 *
 * - `tz`    Optional IANA timezone name; defaults to "UTC".
 * - `days`  Optional ISO weekday array (0=Sun, 6=Sat). When absent, all days
 *           are allowed.
 * - `start` Start time (inclusive) in "HH:MM" 24-hour format (local to tz).
 * - `end`   End time (exclusive) in "HH:MM" 24-hour format (local to tz).
 *           When end <= start (e.g. "22:00"–"06:00") the window wraps midnight.
 */
export interface TimeWindowCondition {
  tz?: string;
  days?: number[];
  start: string;
  end: string;
}

/**
 * An IPv4/IPv6 CIDR allowlist.
 * The client IP must fall inside at least one listed CIDR.
 */
export type IpRangesCondition = string[];

// ── Resource-scope condition (Agent RBAC) ────────────────────────────────────
//
// A resourceScope condition is a typed ceiling on what an agent principal
// (or the human it delegates to) may touch across four dimensions: graph
// labels/relationship-types, MCP server:tool rules, loadable skills, and
// dispatchable subagents. See docs/specs/agent-rbac/spec.md §3.3.
//
// This module owns structural (zod) validation only. Resolution semantics —
// intersecting a ceiling across an agent's own grant, the invoking human's
// grant, and any parent-run scope — live in resolve.ts, which is the only
// consumer that needs to combine multiple resourceScope payloads.

/** Ordered graph-access mode ceiling: "read" < "extend". */
export const graphScopeModeSchema = z.enum(["read", "extend"]);
export type GraphScopeMode = z.infer<typeof graphScopeModeSchema>;

export const graphScopeBudgetSchema = z
  .object({
    maxHops: z.number().int().nonnegative().optional(),
    maxNodes: z.number().int().nonnegative().optional(),
    maxTraversalMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type GraphScopeBudget = z.infer<typeof graphScopeBudgetSchema>;

export const graphScopeSchema = z
  .object({
    labels: z.array(z.string()).optional(),
    relationshipTypes: z.array(z.string()).optional(),
    mode: graphScopeModeSchema.optional(),
    budget: graphScopeBudgetSchema.optional(),
  })
  .strict();
export type GraphScope = z.infer<typeof graphScopeSchema>;

/** Effect of a single MCP "server:tool" glob rule. Note: NOT the "prompt"
 * spelling used elsewhere for human consent UX — the agent-RBAC dimension
 * uses the same three-value vocabulary as packages/mcp-config/src/permissions.ts
 * ("allow" | "deny" | "ask"). Any other spelling is malformed → fail-closed. */
export const mcpRuleEffectSchema = z.enum(["allow", "deny", "ask"]);
export type McpRuleEffect = z.infer<typeof mcpRuleEffectSchema>;

export const mcpRuleSchema = z
  .object({
    pattern: z.string().min(1),
    effect: mcpRuleEffectSchema,
  })
  .strict();
export type McpRule = z.infer<typeof mcpRuleSchema>;

export const mcpScopeSchema = z
  .object({
    rules: z.array(mcpRuleSchema),
  })
  .strict();
export type McpScope = z.infer<typeof mcpScopeSchema>;

export const skillsScopeSchema = z
  .object({
    slugs: z.array(z.string()).optional(),
  })
  .strict();
export type SkillsScope = z.infer<typeof skillsScopeSchema>;

export const agentsScopeSchema = z
  .object({
    refs: z.array(z.string()).optional(),
  })
  .strict();
export type AgentsScope = z.infer<typeof agentsScopeSchema>;

export const resourceScopeSchema = z
  .object({
    graph: graphScopeSchema.optional(),
    mcp: mcpScopeSchema.optional(),
    skills: skillsScopeSchema.optional(),
    agents: agentsScopeSchema.optional(),
  })
  .strict();
export type ResourceScopeCondition = z.infer<typeof resourceScopeSchema>;

/**
 * Parse a raw (unknown) resourceScope payload. Returns null when malformed —
 * callers treat null as a validation failure (fail-closed for evaluation,
 * and "no ceiling contributed" is NEVER the right interpretation of null
 * here; resolve.ts must reject a malformed grant/role-grant rather than
 * silently treating it as unrestricted).
 */
export function parseResourceScope(
  raw: unknown,
): ResourceScopeCondition | null {
  const result = resourceScopeSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * The full condition schema: a plain object whose keys map to typed condition
 * values. All keys must be known — an unknown key fails evaluation.
 */
export interface ConditionsSchema {
  time_window?: TimeWindowCondition;
  /** IPv4 + IPv6 CIDR list. Also accepted as `ip_allow` (alias). */
  ip_ranges?: IpRangesCondition;
  /** Alias for ip_ranges. */
  ip_allow?: IpRangesCondition;
  /** Agent RBAC resource-scope ceiling. See §3.3 of docs/specs/agent-rbac/spec.md. */
  resourceScope?: ResourceScopeCondition;
}

/** All known condition keys. Any key absent from this set triggers fail-closed. */
const KNOWN_CONDITION_KEYS: ReadonlySet<string> = new Set([
  "time_window",
  "ip_ranges",
  "ip_allow",
  "resourceScope",
]);

// ── HH:MM parser ──────────────────────────────────────────────────────────────

/** Returns total minutes since midnight from "HH:MM". Returns null on parse failure. */
function parseHhmm(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return parseInt(match[1]!, 10) * 60 + parseInt(match[2]!, 10);
}

// ── Timezone-aware time-in-window check ──────────────────────────────────────

/**
 * Returns the minutes-since-midnight and weekday (0=Sun) for `now` in the
 * named IANA timezone, falling back to UTC when the name is unrecognised or
 * Intl.DateTimeFormat is unavailable.
 *
 * We use Intl.DateTimeFormat to derive the "local" hour/minute/weekday so
 * there is zero dependency on a timezone database library.
 */
function localTimeOfDay(
  now: Date,
  tz: string,
): { minuteOfDay: number; weekday: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    let hour: number | null = null;
    let minute: number | null = null;
    let weekdayStr: string | null = null;

    for (const part of parts) {
      if (part.type === "hour") hour = parseInt(part.value, 10);
      if (part.type === "minute") minute = parseInt(part.value, 10);
      if (part.type === "weekday") weekdayStr = part.value;
    }
    if (hour === null || minute === null || weekdayStr === null) return null;

    // Intl weekday short in en-US: Sun Mon Tue Wed Thu Fri Sat
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const weekday = weekdayMap[weekdayStr];
    if (weekday === undefined) return null;

    // Intl uses "24" for midnight in some engines — normalise to 0.
    const normalHour = hour === 24 ? 0 : hour;
    return { minuteOfDay: normalHour * 60 + minute, weekday };
  } catch {
    return null;
  }
}

/**
 * Evaluates a time_window condition.
 * Returns null when the condition object is malformed (caller treats as false).
 */
function evalTimeWindow(condition: unknown, now: Date): boolean | null {
  if (
    typeof condition !== "object" ||
    condition === null ||
    Array.isArray(condition)
  ) {
    return null;
  }
  const c = condition as Record<string, unknown>;

  const tz =
    c["tz"] !== undefined
      ? typeof c["tz"] === "string"
        ? c["tz"]
        : null
      : "UTC";
  if (tz === null) return null; // malformed tz type

  const startMin = parseHhmm(c["start"]);
  const endMin = parseHhmm(c["end"]);
  if (startMin === null || endMin === null) return null;

  // Optional days filter: array of 0–6 integers.
  let days: number[] | null = null;
  if (c["days"] !== undefined) {
    if (
      !Array.isArray(c["days"]) ||
      !c["days"].every(
        (d) => typeof d === "number" && d >= 0 && d <= 6 && Number.isInteger(d),
      )
    ) {
      return null;
    }
    days = c["days"] as number[];
  }

  const local = localTimeOfDay(now, tz);
  if (local === null) {
    // Timezone resolution failed — fail-closed.
    return false;
  }

  const { minuteOfDay, weekday } = local;

  // Weekday filter.
  if (days !== null && !days.includes(weekday)) return false;

  // Time-window check — handle midnight wrap (end < start).
  if (endMin > startMin) {
    // Normal window: start ≤ now < end
    return minuteOfDay >= startMin && minuteOfDay < endMin;
  } else if (endMin < startMin) {
    // Wraps midnight: now ≥ start OR now < end
    return minuteOfDay >= startMin || minuteOfDay < endMin;
  } else {
    // start === end: zero-length window — never allowed.
    return false;
  }
}

// ── IPv4/IPv6 CIDR matching ───────────────────────────────────────────────────
//
// Implemented without a CIDR library to keep the package dep-free. The
// implementation handles:
//   - Standard IPv4 CIDRs (e.g. "192.168.1.0/24")
//   - Standard IPv6 CIDRs (e.g. "2001:db8::/32")
//   - IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:aabb:ccdd) matched against
//     IPv4 CIDRs so tools that normalise client IPs to IPv6 still work.

/** Parse an IPv4 address string into a 32-bit unsigned integer, or null. */
function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = parseInt(part, 10);
    if (byte > 255) return null;
    n = (n << 8) | byte;
  }
  // Treat as unsigned 32-bit.
  return n >>> 0;
}

/** Parse an IPv6 address string into a Uint16Array (8 groups of 16 bits), or null. */
function parseIpv6(ip: string): Uint16Array | null {
  // Strip brackets (e.g. "[::1]").
  const stripped = ip.replace(/^\[|\]$/g, "");

  // Handle IPv4-mapped: ::ffff:a.b.c.d
  const v4mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(
    stripped,
  );
  if (v4mapped) {
    const v4 = parseIpv4(v4mapped[1]!);
    if (v4 === null) return null;
    const result = new Uint16Array(8);
    result[5] = 0xffff;
    result[6] = (v4 >>> 16) & 0xffff;
    result[7] = v4 & 0xffff;
    return result;
  }

  // Handle ::ffff:aabb:ccdd (compact hex v4-mapped)
  const v4mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(
    stripped,
  );
  if (v4mappedHex) {
    const hi = parseInt(v4mappedHex[1]!, 16);
    const lo = parseInt(v4mappedHex[2]!, 16);
    const result = new Uint16Array(8);
    result[5] = 0xffff;
    result[6] = hi;
    result[7] = lo;
    return result;
  }

  const halves = stripped.split("::");
  if (halves.length > 2) return null; // malformed

  const expandGroup = (s: string): number[] | null => {
    if (s === "") return [];
    const segs = s.split(":");
    const out: number[] = [];
    for (const seg of segs) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(seg)) return null;
      out.push(parseInt(seg, 16));
    }
    return out;
  };

  let groups: number[];
  if (halves.length === 2) {
    const left = expandGroup(halves[0]!);
    const right = expandGroup(halves[1]!);
    if (left === null || right === null) return null;
    const gap = 8 - left.length - right.length;
    if (gap < 0) return null;
    groups = [...left, ...Array<number>(gap).fill(0), ...right];
  } else {
    const all = expandGroup(stripped);
    if (all === null || all.length !== 8) return null;
    groups = all;
  }

  if (groups.length !== 8) return null;
  return Uint16Array.from(groups);
}

/** Return true when addr falls inside network/prefixLen (IPv4). */
function ipv4InCidr(addr: number, network: number, prefixLen: number): boolean {
  if (prefixLen < 0 || prefixLen > 32) return false;
  if (prefixLen === 0) return true;
  const mask = prefixLen === 32 ? 0xffffffff : ~(0xffffffff >>> prefixLen);
  return (addr & mask) >>> 0 === (network & mask) >>> 0;
}

/** Return true when addr falls inside network/prefixLen (IPv6, 128 bits). */
function ipv6InCidr(
  addr: Uint16Array,
  network: Uint16Array,
  prefixLen: number,
): boolean {
  if (prefixLen < 0 || prefixLen > 128) return false;
  let remaining = prefixLen;
  for (let i = 0; i < 8; i++) {
    if (remaining <= 0) break;
    const bits = Math.min(remaining, 16);
    const mask = bits === 16 ? 0xffff : ~(0xffff >>> bits) & 0xffff;
    if ((addr[i]! & mask) !== (network[i]! & mask)) return false;
    remaining -= bits;
  }
  return true;
}

/** Parse a CIDR string (IPv4 or IPv6 with optional prefix). Returns null on failure. */
function parseCidr(
  cidr: string,
):
  | { kind: "v4"; network: number; prefix: number }
  | { kind: "v6"; network: Uint16Array; prefix: number }
  | null {
  const slashIdx = cidr.lastIndexOf("/");
  const ipPart = slashIdx >= 0 ? cidr.slice(0, slashIdx) : cidr;
  const prefixStr = slashIdx >= 0 ? cidr.slice(slashIdx + 1) : null;

  const prefix4 = prefixStr !== null ? parseInt(prefixStr, 10) : 32;
  const prefix6 = prefixStr !== null ? parseInt(prefixStr, 10) : 128;

  // Try IPv4 first.
  const v4 = parseIpv4(ipPart);
  if (v4 !== null) {
    if (prefixStr !== null && (isNaN(prefix4) || prefix4 < 0 || prefix4 > 32))
      return null;
    return { kind: "v4", network: v4, prefix: prefix4 };
  }

  // Try IPv6.
  const v6 = parseIpv6(ipPart);
  if (v6 !== null) {
    if (prefixStr !== null && (isNaN(prefix6) || prefix6 < 0 || prefix6 > 128))
      return null;
    return { kind: "v6", network: v6, prefix: prefix6 };
  }

  return null;
}

/**
 * Returns true when `clientIp` is within at least one of the given CIDRs.
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are matched against IPv4 CIDRs.
 *
 * @returns false when clientIp is null, unparseable, or in no matching CIDR.
 */
function ipInRanges(clientIp: string | null, cidrs: string[]): boolean {
  if (clientIp === null || cidrs.length === 0) return false;

  const ipStr = clientIp.trim();
  const v4 = parseIpv4(ipStr);
  const v6 = v4 === null ? parseIpv6(ipStr) : null;

  if (v4 === null && v6 === null) return false; // unparseable IP → fail closed

  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed === null) continue; // malformed CIDR — skip, don't crash

    if (parsed.kind === "v4") {
      // Direct IPv4 match.
      if (v4 !== null && ipv4InCidr(v4, parsed.network, parsed.prefix))
        return true;
      // IPv4-mapped IPv6 (::ffff:a.b.c.d) should also match IPv4 CIDRs.
      if (v6 !== null && v6[5] === 0xffff) {
        const mappedV4 = ((v6[6]! << 16) | v6[7]!) >>> 0;
        if (ipv4InCidr(mappedV4, parsed.network, parsed.prefix)) return true;
      }
    } else {
      // IPv6 CIDR: match directly.
      if (v6 !== null && ipv6InCidr(v6, parsed.network, parsed.prefix))
        return true;
      // Also normalise a raw IPv4 addr to IPv4-mapped IPv6 for v6 CIDRs
      // (e.g. ::ffff:0:0/96 covers all IPv4-mapped addresses).
      if (v4 !== null) {
        const mapped = new Uint16Array(8);
        mapped[5] = 0xffff;
        mapped[6] = (v4 >>> 16) & 0xffff;
        mapped[7] = v4 & 0xffff;
        if (ipv6InCidr(mapped, parsed.network, parsed.prefix)) return true;
      }
    }
  }

  return false;
}

// ── Evaluator context ─────────────────────────────────────────────────────────

export interface ConditionEvalContext {
  /** Wall-clock time of the request. Passed explicitly for testability. */
  now: Date;
  /** Client IP address string. Null when unavailable (e.g. internal call). */
  clientIp: string | null;
}

// ── Main evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate a conditionsJsonb value against the invocation context.
 *
 * Semantics:
 *   - null / undefined / {}           → true  (unconditional)
 *   - Non-object or array             → false (malformed — fail closed)
 *   - Object with all known keys      → AND   (all must pass)
 *   - Object with any unknown key     → false (fail-closed — unknown = deny)
 *
 * @param conditions  The raw conditionsJsonb from the DB (type unknown).
 * @param ctx         The evaluation context: current time + client IP.
 */
export function evaluateConditions(
  conditions: unknown,
  ctx: ConditionEvalContext,
): boolean {
  // Absent / null → unconditional grant.
  if (conditions === null || conditions === undefined) return true;

  // Must be a plain (non-array) object.
  if (typeof conditions !== "object" || Array.isArray(conditions)) return false;

  const obj = conditions as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Empty object → unconditional grant.
  if (keys.length === 0) return true;

  // Fail-closed on any unknown key.
  for (const key of keys) {
    if (!KNOWN_CONDITION_KEYS.has(key)) return false;
  }

  // Evaluate each present condition — all must pass (AND semantics).

  // ── time_window ─────────────────────────────────────────────────────────────
  if ("time_window" in obj) {
    const result = evalTimeWindow(obj["time_window"], ctx.now);
    if (result === null || result === false) return false;
  }

  // ── ip_ranges / ip_allow ───────────────────────────────────────────────────
  const ipConditionRaw =
    "ip_ranges" in obj
      ? obj["ip_ranges"]
      : "ip_allow" in obj
        ? obj["ip_allow"]
        : undefined;
  if (ipConditionRaw !== undefined) {
    // Must be an array of strings.
    if (
      !Array.isArray(ipConditionRaw) ||
      !ipConditionRaw.every((entry) => typeof entry === "string")
    ) {
      return false; // malformed → fail closed
    }
    if (!ipInRanges(ctx.clientIp, ipConditionRaw as string[])) return false;
  }

  // ── resourceScope ────────────────────────────────────────────────────────────
  // Structural validation only: a malformed resourceScope payload fails closed
  // (matches the "Malformed value for a known key → false" design rule at the
  // top of this file). This evaluator does not enforce the scope itself — it
  // only guards against a broken grant row ever being treated as unconditional.
  if ("resourceScope" in obj) {
    if (parseResourceScope(obj["resourceScope"]) === null) return false;
  }

  return true;
}
