/**
 * The "Wrapped agents" panel's rows, as a pure function of the machine's
 * state: one row per known harness (Claude Code, Codex, Cursor, Stella) plus one
 * row per custom agent the collector has ever seen (`tacho hook --agent
 * <name>`, reported in `daemon.agents` with `runtime: "custom"` or any
 * other runtime string this build does not have a harness for).
 *
 * Health is a cascade, evaluated top to bottom, the first match winning:
 *
 *  1. not enrolled/not in `host.harnesses` (a harness row only) → "not_wrapped".
 *  2. the machine is enrolled but the collector is not answering
 *     (`daemon == null`) → "down". A custom row cannot reach this: it only
 *     exists because the collector's own `/status` reported it.
 *  3. hook presence for that harness is incomplete (`hooks.complete ===
 *     false`) → "degraded", "N hooks missing" (harness rows only; custom
 *     agents have no hook family in `tacho status`).
 *  4. the collector's last action failed (`last_error` set) and the spool
 *     has not drained (`spool_depth > 0`) → "degraded", the error.
 *  5. the agent was last seen more than seven days ago → "idle". A stale
 *     spool reading is not a fresh delivery, so staleness is checked before
 *     the spool is trusted for anything. This is where a custom agent lands
 *     after being quiet for a week: still listed, nothing wrong, just not
 *     running now.
 *  6. the control plane refused events outright (`quarantined > 0`) →
 *     "degraded", "N events refused by Oxagen". Quarantining takes the
 *     events off the spool and clears the error, so this has to be read
 *     before either is trusted or refused events read as delivered.
 *  7. the agent was seen (`last_seen_at`) more recently than the last
 *     successful ship (`last_ingest_at` null or older) and the spool has
 *     not drained → "pending" ("recorded, waiting to send"), or
 *     "degraded" once that has lasted more than ten minutes.
 *  8. seen, with an empty spool and either a ship at or after the last run
 *     or no error → "healthy".
 *  9. wrapped but never seen → "idle" ("wrapped · no runs recorded yet").
 *
 * Everything the spool reports (`last_ingest_at`, `spool_depth`,
 * `last_error`, `quarantined`) is daemon-global; only `last_seen_at` is per
 * agent. So a reading is never attributed to one agent unless the spool is
 * empty, which is the only state that holds for every agent at once.
 */
import type {
  DaemonAgentSummary,
  DaemonStatus,
  DesktopState,
  HostView,
} from "./bridge";
import {
  ago,
  HARNESS_LABEL,
  HARNESS_TIER,
  HARNESSES,
  type Harness,
  isConnected,
  type Tier,
  TIER_LABEL,
  TIER_OMITS,
  TIER_RECORDS,
} from "./commands";
import type {
  TachoHookPresence,
  TachoModelCredential,
  TachoStatus,
} from "./tacho-status";

export type AgentHealth =
  | "healthy"
  | "idle"
  | "pending"
  | "degraded"
  | "down"
  | "not_wrapped";

export interface AgentRow {
  key: string;
  label: string;
  kind: "harness" | "custom" | "connected";
  /** Covered by Oxagen at all — hooks written, or an MCP entry written. */
  wrapped: boolean;
  health: AgentHealth;
  summary: string;
  details: string[];
  lastSeenAt: string | null;
  sessionsLive: number;
  sessionsTotal: number;
  /**
   * Which enforcement tier this row is (ADR-078). Every row carries one, so
   * no surface has to infer it, and a connected row can never be rendered as
   * though it were wrapped.
   */
  tier: Tier;
  /** "Wrapped" or "Connected". */
  tierLabel: string;
  /** What this tier records. */
  records: string;
  /**
   * What this tier does not record. Never optional and never empty: ADR-078
   * §2 is that neither tier dominates the other, and a row that shows only
   * what it captures reads as coverage it does not have.
   */
  omits: string;
  /**
   * Other MCP servers configured in this connected app, which Oxagen does not
   * see. Empty for a wrapped row. Nothing in this repo can close that gap, so
   * the honest thing is to show its size.
   */
  unseenServers: string[];
}

const TEN_MINUTES_MS = 10 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Human-readable text for a health value; the accessible label, not a color. */
export const HEALTH_LABEL: Record<AgentHealth, string> = {
  healthy: "Healthy",
  idle: "Idle",
  pending: "Sending",
  degraded: "Needs attention",
  down: "Collector down",
  not_wrapped: "Not wrapped",
};

function hookPresenceFor(
  tacho: TachoStatus | null,
  harness: Harness,
): TachoHookPresence | undefined {
  if (!tacho) return undefined;
  switch (harness) {
    case "claude-code":
      return tacho.hooks;
    case "codex":
      return tacho.codexHooks;
    case "cursor":
      return tacho.cursorHooks;
    case "stella":
      return tacho.stellaHooks;
    // A connected app has no hooks to be present or missing. Returning
    // undefined keeps it out of the hook branch of the health cascade rather
    // than reporting "0 hooks missing", which would read as wrapped-and-fine.
    default:
      return undefined;
  }
}

function versionFor(host: HostView | null, harness: Harness): string | null {
  if (!host) return null;
  switch (harness) {
    case "claude-code":
      return host.claude_version ?? null;
    case "codex":
      return host.codex_version ?? null;
    case "cursor":
      return host.cursor_version ?? null;
    case "stella":
      return host.stella_version ?? null;
    // A GUI app answers no `--version`, so there is none to show.
    default:
      return null;
  }
}

interface HealthInput {
  daemonUp: boolean;
  hookPresence: TachoHookPresence | undefined;
  lastSeenAt: string | null;
  lastIngestAt: string | null;
  spoolDepth: number;
  lastError: string | null;
  quarantined: number;
  now: number;
}

function healthFor(input: HealthInput): {
  health: AgentHealth;
  summary: string;
} {
  if (!input.daemonUp) {
    return { health: "down", summary: "collector not answering" };
  }
  if (input.hookPresence !== undefined && !input.hookPresence.complete) {
    const n = input.hookPresence.missing.length;
    return {
      health: "degraded",
      summary: `${n} hook${n === 1 ? "" : "s"} missing`,
    };
  }
  if (input.lastError !== null && input.spoolDepth > 0) {
    return {
      health: "degraded",
      summary: `Oxagen refused or unreachable: ${input.lastError}`,
    };
  }
  if (input.lastSeenAt !== null) {
    const seenMs = Date.parse(input.lastSeenAt);
    // Nothing has run in a week: whatever the spool says, that is quiet, not
    // a fresh delivery. Report it as idle rather than a stale "healthy".
    if (input.now - seenMs > SEVEN_DAYS_MS) {
      return {
        health: "idle",
        summary: `last run ${ago(input.lastSeenAt, input.now)}`,
      };
    }
    // The control plane refused these outright: they are off the spool and
    // leave no error behind, so every reading below would call them
    // delivered. Say so before anything claims they arrived.
    if (input.quarantined > 0) {
      const n = input.quarantined;
      return {
        health: "degraded",
        summary: `${n} event${n === 1 ? "" : "s"} refused by Oxagen`,
      };
    }
    // `lastIngestAt` is the daemon's last successful ship, not this agent's:
    // the WAL tracks shipped state per session and keeps no ship timestamp,
    // so there is no per-agent cursor to read. With a backlog deeper than one
    // batch, another agent's batch landing after this agent's last run would
    // otherwise read as delivery. An empty spool is what proves this agent's
    // events left the machine, so it is required here too.
    const shippedAfterSeen =
      input.spoolDepth === 0 &&
      input.lastIngestAt !== null &&
      Date.parse(input.lastIngestAt) >= seenMs;
    const drained = input.spoolDepth === 0 && input.lastError === null;
    if (shippedAfterSeen || drained) {
      return {
        health: "healthy",
        summary: `last run ${ago(input.lastSeenAt, input.now)} · delivered to Oxagen`,
      };
    }
    // Seen more recently than the last ship, with a backlog: still moving,
    // unless it has been stuck long enough to call out.
    const stuckMs = input.now - seenMs;
    return stuckMs > TEN_MINUTES_MS
      ? { health: "degraded", summary: "recorded, waiting to send" }
      : { health: "pending", summary: "recorded, waiting to send" };
  }
  return { health: "idle", summary: "wrapped · no runs recorded yet" };
}

/**
 * The tier fields, filled from one place so no row can be built without them.
 * `omits` is as mandatory as `records`: a row that shows only what it captures
 * reads as coverage it does not have (ADR-078 §2).
 */
function tierFields(
  tier: Tier,
  unseenServers: string[] = [],
): Pick<
  AgentRow,
  "tier" | "tierLabel" | "records" | "omits" | "unseenServers"
> {
  return {
    tier,
    tierLabel: TIER_LABEL[tier],
    records: TIER_RECORDS[tier],
    omits: TIER_OMITS[tier],
    unseenServers,
  };
}

/**
 * One line on how the harness gets its model credential (ADR-142). Brokered
 * means the harness holds a run token and the gateway supplies the key from
 * its custody; otherwise the harness's own credential crosses the proxy, and
 * the line says why when the status did.
 */
export function credentialDetail(credential: TachoModelCredential): string {
  if (credential.brokered) return "credential brokered by the gateway";
  switch (credential.reason) {
    case "subscription_login":
      return "own login crosses the proxy (subscription, nothing to broker)";
    case "symlink":
      return "own credential crosses the proxy (settings file is a symlink)";
    case "no_file":
      return "own credential crosses the proxy (no settings file yet)";
    default:
      return "own credential crosses the proxy";
  }
}

/** One row per known harness, enrolled or not. */
function harnessRow(
  h: Harness,
  state: DesktopState,
  tacho: TachoStatus | null,
  agent: DaemonAgentSummary | undefined,
  now: number,
): AgentRow {
  const host = state.host;
  const wrapped = host !== null && host.harnesses.includes(h);
  const details: string[] = [];
  const version = versionFor(host, h);
  if (version) details.push(`${HARNESS_LABEL[h]} ${version}`);
  const presence = hookPresenceFor(tacho, h);
  if (presence) {
    details.push(
      presence.complete
        ? "hooks complete"
        : `hooks missing: ${presence.missing.join(", ")}`,
    );
  }
  const credential = tacho?.modelCredentials?.find((c) => c.harness === h);
  if (credential) details.push(credentialDetail(credential));

  if (!wrapped) {
    return {
      key: h,
      label: HARNESS_LABEL[h],
      kind: "harness",
      wrapped: false,
      health: "not_wrapped",
      summary: agent
        ? `not wrapped · last seen ${ago(agent.last_seen_at, now)}`
        : "not wrapped",
      details,
      lastSeenAt: agent?.last_seen_at ?? null,
      sessionsLive: agent?.sessions_live ?? 0,
      sessionsTotal: agent?.sessions_total ?? 0,
      ...tierFields(HARNESS_TIER[h]),
    };
  }

  const { health, summary } = healthFor({
    daemonUp: state.daemon != null,
    hookPresence: presence,
    lastSeenAt: agent?.last_seen_at ?? null,
    lastIngestAt: state.daemon?.last_ingest_at ?? null,
    spoolDepth: state.daemon?.spool_depth ?? 0,
    lastError: state.daemon?.last_error ?? null,
    quarantined: state.daemon?.quarantined ?? 0,
    now,
  });
  return {
    key: h,
    label: HARNESS_LABEL[h],
    kind: "harness",
    wrapped: true,
    health,
    summary,
    details,
    lastSeenAt: agent?.last_seen_at ?? null,
    sessionsLive: agent?.sessions_live ?? 0,
    sessionsTotal: agent?.sessions_total ?? 0,
    ...tierFields(HARNESS_TIER[h]),
  };
}

/**
 * One row per custom agent the collector has ever seen. Only reachable from
 * `computeAgentRows` when `daemon.agents` holds the entry, so the collector
 * is by definition up here, and `daemon` is the non-null document that
 * produced it.
 */
function customRow(
  agent: DaemonAgentSummary,
  daemon: DaemonStatus,
  now: number,
): AgentRow {
  const { health, summary } = healthFor({
    daemonUp: true,
    hookPresence: undefined,
    lastSeenAt: agent.last_seen_at,
    lastIngestAt: daemon.last_ingest_at ?? null,
    spoolDepth: daemon.spool_depth ?? 0,
    lastError: daemon.last_error ?? null,
    quarantined: daemon.quarantined ?? 0,
    now,
  });
  return {
    key: agent.key,
    label: agent.label,
    kind: "custom",
    wrapped: true,
    health,
    summary,
    details: ["reports through tacho hook"],
    lastSeenAt: agent.last_seen_at,
    sessionsLive: agent.sessions_live,
    sessionsTotal: agent.sessions_total,
    // A custom agent calls `tacho hook` around its own steps, so it is
    // wrapped, with the same attestation caveat as the built-in harnesses.
    ...tierFields("harness"),
  };
}

/**
 * One row per connected app (ADR-078). Its health is not the wrapped cascade
 * and deliberately shares none of it:
 *
 *   1. not in `host.harnesses` → "not_wrapped" (the row still shows, so the
 *      operator can see the app exists and is not covered);
 *   2. the collector is not answering → "down". A connected app talks to the
 *      gateway, which is *in* the collector, so a collector that is down is
 *      an app with no Oxagen tools at all — a harder failure than for a
 *      wrapped agent, whose hook falls back to the cached bundle;
 *   3. the MCP entry is missing or belongs to an older enrollment →
 *      "degraded". This is the connected equivalent of missing hooks;
 *   4. calls have been refused → "degraded" is wrong here, and it is not
 *      used: a refusal is the gateway working. Refusals are reported as a
 *      count in the details, never as ill health;
 *   5. calls seen → "healthy"; never seen → "idle".
 *
 * There is no "recorded, waiting to send" state: a gateway call is recorded
 * synchronously on the daemon's chain, so there is no per-app spool to be
 * behind on.
 */
function connectedRow(
  h: Harness,
  state: DesktopState,
  tacho: TachoStatus | null,
  now: number,
): AgentRow {
  const host = state.host;
  const enrolled = host !== null && host.harnesses.includes(h);
  const presence = tacho?.claudeDesktop;
  const seen = (state.daemon?.connected ?? []).find((entry) =>
    entry.client.toLowerCase().includes("claude"),
  );
  const unseen = presence?.otherServerNames ?? [];
  const details: string[] = [];
  if (seen) {
    details.push(
      `${seen.calls} tool call${seen.calls === 1 ? "" : "s"} through Oxagen`,
    );
    if (seen.refused > 0)
      // Not a fault: this is the control working. Worded so it never reads
      // as an error the operator has to clear.
      details.push(`${seen.refused} refused by its mandate`);
  }
  if (unseen.length > 0)
    details.push(
      `${unseen.length} other MCP server${unseen.length === 1 ? "" : "s"} in this app that Oxagen does not see`,
    );

  const fields = tierFields("gateway", unseen);
  const base = {
    key: h,
    label: HARNESS_LABEL[h],
    kind: "connected" as const,
    details,
    lastSeenAt: seen?.last_seen_at ?? null,
    // A connected app has no sessions. Zero is the truth, not a placeholder.
    sessionsLive: 0,
    sessionsTotal: 0,
    ...fields,
  };

  if (!enrolled) {
    return {
      ...base,
      wrapped: false,
      health: "not_wrapped",
      summary: "not connected",
    };
  }
  if (state.daemon == null) {
    return {
      ...base,
      wrapped: true,
      health: "down",
      summary: "collector not answering, so this app has no Oxagen tools",
    };
  }
  if (presence !== undefined && !presence.present) {
    return {
      ...base,
      wrapped: true,
      health: "degraded",
      summary: presence.foreignEnrollment
        ? "an entry from an earlier enrollment is still in this app; reconnect it"
        : "connected, but the entry is missing from this app's config",
    };
  }
  if (seen === undefined) {
    return {
      ...base,
      wrapped: true,
      health: "idle",
      summary:
        "connected · no tool calls yet. Restart the app if you just connected it.",
    };
  }
  return {
    ...base,
    wrapped: true,
    health: "healthy",
    summary: `last tool call ${ago(seen.last_seen_at, now)}`,
  };
}

/** The rows of the "Wrapped agents" panel, as a pure function of state. */
export function computeAgentRows(
  state: DesktopState,
  tacho: TachoStatus | null,
  now: number = Date.now(),
): AgentRow[] {
  const daemon = state.daemon;
  const daemonAgents = daemon?.agents ?? [];
  // Matched on `runtime`, not `harness`: a custom agent can be named after a
  // built-in harness (`tacho hook --agent codex`, runtime "custom", harness
  // "codex") and must not be folded into the built-in Codex row.
  const byRuntime = new Map(daemonAgents.map((a) => [a.runtime, a]));
  const rows: AgentRow[] = HARNESSES.map((h) =>
    isConnected(h)
      ? connectedRow(h, state, tacho, now)
      : harnessRow(h, state, tacho, byRuntime.get(h), now),
  );
  if (daemon) {
    const known = new Set<string>(HARNESSES);
    for (const agent of daemonAgents) {
      if (known.has(agent.runtime)) continue;
      rows.push(customRow(agent, daemon, now));
    }
  }
  return rows;
}

/** "3 agents wrapped · 2 healthy · 1 idle" for the This machine panel. */
export function summarizeAgents(rows: AgentRow[]): string {
  const wrapped = rows.filter((r) => r.wrapped);
  if (wrapped.length === 0) return "no agents wrapped yet";
  const counts = new Map<AgentHealth, number>();
  for (const r of wrapped)
    counts.set(r.health, (counts.get(r.health) ?? 0) + 1);
  const order: AgentHealth[] = [
    "healthy",
    "idle",
    "pending",
    "degraded",
    "down",
  ];
  const parts = order
    .filter((h) => (counts.get(h) ?? 0) > 0)
    .map((h) => `${counts.get(h)} ${HEALTH_LABEL[h].toLowerCase()}`);
  return `${wrapped.length} agent${wrapped.length === 1 ? "" : "s"} wrapped · ${parts.join(" · ")}`;
}
