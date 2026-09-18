/**
 * policy.ts — the `steering` block of Oxagen settings, and how the scopes
 * combine.
 *
 * ## The two switches
 *
 * `autoSync` and `blockStaleRuns` are the two the product promises: pull
 * `.oxagen/` forward by itself, and refuse to run a prompt while it is
 * behind. Everything else here exists to make those two safe to leave on.
 *
 * ## Why local can only tighten
 *
 * The scopes are the ones `@oxagen/mcp-config` already resolves:
 *
 *   1. user   — `~/.config/oxagen/settings.json`
 *   2. project— `<root>/.oxagen/settings.json`      (committed: the team's)
 *   3. local  — `<root>/.oxagen/settings.local.json` (personal, gitignored)
 *   4. workspace — the platform policy, read from Oxagen
 *
 * For MCP permissions those merge with the later scope winning outright. A
 * freshness gate cannot merge that way. The whole point of `blockStaleRuns`
 * is that an organisation can insist its agents run on records that are in
 * force; a personal file that could set it back to `false` would make the
 * setting decorative, and the developer it protects is exactly the one who
 * would turn it off at the first inconvenience.
 *
 * So the two booleans are combined with OR, not with overwrite: a later
 * scope may switch a gate ON and may never switch one OFF. The scalars that
 * carry no authority (`remote`, `branch`, `fetchIntervalSeconds`) keep the
 * ordinary later-wins behaviour, and `exclude` is a union — an excluded path
 * is a path that never participates, and un-excluding one from a personal
 * file would be the same loophole in a different shape.
 *
 * The one deliberate exception is {@link resolveSteeringPolicy}'s `emergency`
 * input, the `OXAGEN_STEERING_FRESHNESS=off` escape hatch. A gate with no way
 * out is a gate that gets uninstalled the first time a remote is unreachable
 * at 3am; an escape hatch that has to be typed, is never persisted, and is
 * named in the audit line the gate emits, is the version people leave
 * installed.
 */
import { z } from "zod";

/** Scopes in precedence order, lowest first. */
export const POLICY_SCOPES = [
  "default",
  "user",
  "project",
  "local",
  "workspace",
] as const;
export type PolicyScope = (typeof POLICY_SCOPES)[number];

/**
 * The `steering` block as it may appear in any settings file. Every member
 * optional: a file says only what it wants to change.
 */
export const steeringPolicyFileSchema = z
  .object({
    /**
     * Pull `.oxagen/` forward from the remote production branch, without
     * being asked, when this checkout is behind it. Never runs while
     * `.oxagen/` holds uncommitted work.
     */
    autoSync: z.boolean().optional(),
    /**
     * Refuse to run a prompt while `.oxagen/` is behind the remote
     * production branch. Warns either way; this decides whether the warning
     * also stops the turn.
     */
    blockStaleRuns: z.boolean().optional(),
    /** The git remote that carries the production branch. */
    remote: z.string().min(1).optional(),
    /**
     * The production branch. Omitted or null, the remote's own default
     * branch is resolved, which is what a Context PR targets.
     */
    branch: z.string().min(1).nullable().optional(),
    /**
     * Never contact the remote more than once per this many seconds. The
     * check runs on every prompt; a fetch on every prompt would put a
     * network round trip in front of every turn.
     */
    fetchIntervalSeconds: z.number().int().min(0).max(86_400).optional(),
    /**
     * Paths under `.oxagen/`, as git pathspecs relative to the repository
     * root, that take no part in freshness and are never synced.
     */
    exclude: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SteeringPolicyFile = z.infer<typeof steeringPolicyFileSchema>;

/** A fully resolved policy: no optionals, every question answered. */
export interface SteeringPolicy {
  autoSync: boolean;
  blockStaleRuns: boolean;
  remote: string;
  /** null = resolve the remote's default branch at check time. */
  branch: string | null;
  fetchIntervalSeconds: number;
  exclude: string[];
  /** Which scope turned each gate on, for the banner and the audit line. */
  sources: { autoSync: PolicyScope | null; blockStaleRuns: PolicyScope | null };
  /** True when an escape hatch disabled the gates for this process only. */
  suspended: boolean;
  suspendedReason: string | null;
  /**
   * Exclusions named by `.oxagen/settings.local.json` and refused. Reported so
   * the developer is told their setting did nothing, rather than discovering
   * it by being blocked over a record they thought they had excluded.
   */
  refusedExcludes: string[];
}

/**
 * `.oxagen/settings.local.json` is personal by definition and is the one file
 * a sync must never overwrite. It is excluded before any caller can choose
 * otherwise.
 */
export const ALWAYS_EXCLUDED = [".oxagen/settings.local.json"] as const;

export const DEFAULT_POLICY: SteeringPolicy = {
  autoSync: false,
  blockStaleRuns: false,
  remote: "origin",
  branch: null,
  fetchIntervalSeconds: 300,
  exclude: [...ALWAYS_EXCLUDED],
  sources: { autoSync: null, blockStaleRuns: null },
  refusedExcludes: [],
  suspended: false,
  suspendedReason: null,
};

export interface PolicyLayer {
  scope: PolicyScope;
  policy: SteeringPolicyFile;
}

/**
 * The escape hatch, read from the environment rather than from a file so it
 * cannot be committed by accident and cannot outlive the shell that set it.
 * Any of `0`, `off`, `false`, `no` suspends the gates.
 */
export function readEmergencyOverride(
  env: Record<string, string | undefined>,
): { suspended: boolean; reason: string | null } {
  const raw = env.OXAGEN_STEERING_FRESHNESS?.trim().toLowerCase();
  if (raw === undefined || raw === "")
    return { suspended: false, reason: null };
  if (["0", "off", "false", "no"].includes(raw)) {
    return {
      suspended: true,
      reason: "OXAGEN_STEERING_FRESHNESS=off is set in this environment",
    };
  }
  return { suspended: false, reason: null };
}

/**
 * Fold the layers into one policy. See the file header for why the booleans
 * OR and the excludes union while the scalars overwrite.
 */
export function resolveSteeringPolicy(
  layers: readonly PolicyLayer[],
  emergency: { suspended: boolean; reason: string | null } = {
    suspended: false,
    reason: null,
  },
): SteeringPolicy {
  const out: SteeringPolicy = {
    ...DEFAULT_POLICY,
    exclude: [...ALWAYS_EXCLUDED],
    sources: { autoSync: null, blockStaleRuns: null },
    refusedExcludes: [],
  };
  const excluded = new Set<string>(ALWAYS_EXCLUDED);
  const refused = new Set<string>();

  const ordered = [...layers].sort(
    (a, b) => POLICY_SCOPES.indexOf(a.scope) - POLICY_SCOPES.indexOf(b.scope),
  );

  for (const { scope, policy } of ordered) {
    // Ratchet: true from any scope sticks, false from any scope is a no-op.
    if (policy.autoSync === true && !out.autoSync) {
      out.autoSync = true;
      out.sources.autoSync = scope;
    }
    if (policy.blockStaleRuns === true && !out.blockStaleRuns) {
      out.blockStaleRuns = true;
      out.sources.blockStaleRuns = scope;
    }
    if (policy.remote !== undefined) out.remote = policy.remote;
    if (policy.branch !== undefined) out.branch = policy.branch;
    if (policy.fetchIntervalSeconds !== undefined) {
      out.fetchIntervalSeconds = policy.fetchIntervalSeconds;
    }
    for (const path of policy.exclude ?? []) {
      // `local` is `.oxagen/settings.local.json`: personal, gitignored, and
      // reviewed by nobody. An exclusion from there removes records from the
      // comparison, so a single line in a file the workspace cannot see —
      // `.oxagen/rules`, say — filters away everything that is missing and the
      // verdict comes back `current` with `blockStaleRuns` still nominally on.
      // That is not a preference, it is the gate's off switch, and the one
      // scope that must not hold it is the one nobody else can read.
      //
      // The gates themselves already ratchet — a lower scope may turn one ON
      // and may never turn one OFF — and this is the same rule for the other
      // half of the control. It is refused unconditionally rather than only
      // while a gate is active, so the setting means the same thing whatever
      // the workspace has switched on today.
      //
      // `.oxagen/settings.local.json` itself stays excluded for everyone:
      // ALWAYS_EXCLUDED puts it there before any layer is read.
      if (scope === "local") {
        refused.add(path);
        continue;
      }
      excluded.add(path);
    }
  }

  for (const path of refused) if (!excluded.has(path)) out.refusedExcludes.push(path);
  out.refusedExcludes.sort();
  out.exclude = [...excluded].sort();
  if (emergency.suspended) {
    out.suspended = true;
    out.suspendedReason = emergency.reason;
    // The gates are recorded as configured but not enforced, so a banner can
    // still say "blocking is on for this workspace, and it is suspended".
  }
  return out;
}

/** Is the run gate actually going to stop anything right now? */
export function blockingActive(policy: SteeringPolicy): boolean {
  return policy.blockStaleRuns && !policy.suspended;
}

/** Is auto-sync actually going to run right now? */
export function autoSyncActive(policy: SteeringPolicy): boolean {
  return policy.autoSync && !policy.suspended;
}
