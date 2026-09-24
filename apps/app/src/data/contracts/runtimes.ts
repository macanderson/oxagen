// The Runtimes view models (roadmap mockups/pages/runtimes.md): the hosts
// agents run on, read from `list_tacho_hosts`, and the agents enrolled on them,
// joined from `list_agents`.
//
// The record has no host row. `tacho.hosts` holds one row per enrollment, and
// an enrollment is one agent key on one machine, so two agents on one
// workstation are two rows here. The page says so rather than grouping rows by
// hostname: a hostname is not an identity, and two machines can share one.
//
// A field is nullable exactly where the contract may not have recorded it
// (§3.4). What no store records at all (the host kind, the tier rolled up per
// host, the telemetry gaps in 24 hours, the hooks written read back at
// check-in, the last checkpoint per host) has no field: the page renders it as
// not recorded and names the gap.
import { z } from "zod";
import { PublicId } from "./common";

const Instant = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();

const RuntimePlatform = z.enum(["darwin", "linux", "win32"]);
export type RuntimePlatform = z.infer<typeof RuntimePlatform>;

/** The enrollment's recorded status. `expired` is not a stored value: the page judges it from `expiresAt`. */
const RuntimeStatus = z.enum(["active", "paused", "suspended", "revoked"]);

/**
 * Where the harnesses send their model calls, as the daemon last reported
 * their configs: `loopback` when every reported config names Oxagen's loopback
 * proxy, `direct` when none does, and `mixed` when some do and some do not.
 * One routed harness never makes the host read `loopback`: the value is the
 * weakest thing the record says, not the strongest. Null when the daemon
 * reported nothing, which is a daemon older than the report, never a harness
 * that has not drifted.
 */
const ModelRoute = z.enum(["loopback", "mixed", "direct"]);
export type ModelRoute = z.infer<typeof ModelRoute>;

export const RuntimeEnrollment = z.object({
  /** The enrollment's public id (`tch_…`). */
  id: PublicId,
  hostname: z.string(),
  platform: RuntimePlatform,
  /** The OS version the host reported at enrollment (`15.6`); null when it reported none. */
  osVersion: z.string().nullable(),
  /** The CPU architecture the host reported at enrollment (`arm64`); null when it reported none. */
  arch: z.string().nullable(),
  /** The OS account the daemon runs as. */
  osUser: z.string(),
  status: RuntimeStatus,
  /** The bundle mode: `enforce` fails closed on a stale bundle, `observe` allows. */
  mode: z.enum(["observe", "enforce"]),
  /** The harnesses the daemon reported on this machine, as it named them. */
  harnesses: z.array(z.string()),
  /** The Claude Code version recorded at enrollment; null for any other harness or an older daemon. */
  claudeVersionAtEnroll: z.string().nullable(),
  /** The collector's version (`wrapper_version`); null before its first report. */
  collectorVersion: z.string().nullable(),
  modelRoute: ModelRoute.nullable(),
  /** The managed settings file that overrides the harness config, when the daemon named one. */
  shadowedBy: z.string().nullable(),
  /**
   * Where the installer wrote the hooks: `true` for the managed settings an
   * administrator distributes, `false` for the user's own settings. Recorded
   * at enrollment.
   */
  managed: z.boolean(),
  lastSeenAt: Instant.nullable(),
  createdAt: Instant,
  expiresAt: Instant,
  revokedAt: Instant.nullable(),
  /** The agent this enrollment belongs to (`org_ns.ws_ns.slug`); empty when the row names none. */
  agentKey: z.string(),
});
export type RuntimeEnrollment = z.infer<typeof RuntimeEnrollment>;

export const RuntimeList = z.object({
  enrollments: z.array(RuntimeEnrollment),
  /** True when the walk stopped at its bound with more rows unread. */
  more: z.boolean(),
});
export type RuntimeList = z.infer<typeof RuntimeList>;

/** One agent identity, as the Agents on this host table reads it. */
export const RuntimeAgent = z.object({
  id: PublicId,
  slug: z.string().min(1),
  name: z.string().min(1),
  agentKey: z.string().min(1),
  harness: z.string().min(1),
  operatorId: PublicId.nullable(),
  principalId: PublicId.nullable(),
  runs30d: Count,
});
export type RuntimeAgent = z.infer<typeof RuntimeAgent>;

export const RuntimeAgents = z.object({
  agents: z.array(RuntimeAgent),
});
export type RuntimeAgents = z.infer<typeof RuntimeAgents>;
