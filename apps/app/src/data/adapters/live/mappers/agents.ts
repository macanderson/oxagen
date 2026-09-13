// Recorded rows → the Agents view models (spec vocabulary). Pure: no I/O.
//
// Each mapper takes what the live adapter read — the outputs of the agent tools
// it invoked (list_agent_defs, get_agent_def, list_agent_roles, list_iam_roles,
// list_tacho_hosts) and drizzle rows for the stores no agent tool exposes
// (iam.principals, tacho.hosts facts, tacho.incidents) — and returns the view
// model with every field the stores do not record set to null. Never a zero, an
// empty list or a guessed enum standing in for "not recorded".
//
// Where a view-model schema cannot carry that null yet, the live adapter keeps
// the method not-backed: `RECORDED_PROBES` are rows these mappers produce from
// the least a store can hold, and `rejectedPaths` names the fields a schema
// refuses in them. The PR that relaxes a view-model field turns the method live
// with no change here.
import type { AgentDefinitionGetOutput } from "@oxagen/oxagen/contracts/agent.definition.get";
import type { AgentDefinitionListOutput } from "@oxagen/oxagen/contracts/agent.definition.list";
import type { AgentRoleAssignmentRow } from "@oxagen/oxagen/contracts/agent.role.list";
import type { IamRoleRow } from "@oxagen/oxagen/contracts/iam.role.list";
import type { TachoHostListOutput } from "@oxagen/oxagen/contracts/tacho.host.list";
import type {
  apiKeys,
  principals,
  tachoHosts,
  tachoIncidents,
} from "@oxagen/database/schema";
import { TACHO_INCIDENT_KINDS } from "@oxagen/database/schema";
import type { z } from "zod";
import {
  type AgentDefinition,
  type AgentDetail,
  type AgentRow,
  type AgentStatus,
  type Avatar,
  type BeltDecision,
  type EnforcementTier,
  Harness,
  type Incident,
  type Toolbelt,
  type ToolbeltEntry,
} from "@/data/contracts";

// ---- Source rows ---------------------------------------------------------------

export type DefinitionRow = AgentDefinitionListOutput["agents"][number];
export type HostSummary = TachoHostListOutput["hosts"][number];

/** The agent's delegated principal (`iam.principals`, kind=agent) and its operator. */
export type PrincipalFacts = Pick<
  typeof principals.$inferSelect,
  "publicId" | "status"
> & {
  /** `auth.users.public_id` of `principals.parent_user_id`: the operator. */
  operatorPublicId: string | null;
};

/** Enrollment facts `list_tacho_hosts` does not return. */
export type HostFacts = Pick<
  typeof tachoHosts.$inferSelect,
  "deviceKeyFingerprint"
> & {
  /** The host's credential (`auth.api_keys` by `tacho.hosts.api_key_id`). Never the hash. */
  apiKey: Pick<
    typeof apiKeys.$inferSelect,
    "keyPrefix" | "createdAt" | "lastUsedAt"
  > | null;
  /** `min(tacho.sessions.started_at)` for the agent key: its first recorded frame. */
  firstSessionAt: Date | null;
};

export type IncidentRow = Pick<
  typeof tachoIncidents.$inferSelect,
  | "publicId"
  | "kind"
  | "severity"
  | "detectedAt"
  | "detectedBy"
  | "resolvedAt"
  | "resolutionNote"
> & {
  hostname: string | null;
  /** `tacho.sessions.public_id`: the run the incident was detected in. */
  sessionPublicId: string | null;
  /** `iam.principals.public_id` of `resolved_by_principal_id`. */
  resolvedByPublicId: string | null;
};

/** Everything recorded about one agent key, joined across the stores. */
export type AgentSource = {
  key: string;
  workspaceSlug: string;
  /** The DB-backed definition. Null for an agent that is only enrolled. */
  definition: DefinitionRow | null;
  /** The enrolled host. Null until the agent is enrolled. */
  host: HostSummary | null;
  principal: PrincipalFacts | null;
  /** The tier the agent's latest run recorded (`tacho.sessions.enforcement_tier`). */
  latestTier: EnforcementTier | null;
};

// ---- Recorded view models ------------------------------------------------------

type Widen<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null };

/** `AgentRow` as the stores hold it: these fields have no column today. */
export type RecordedAgentRow = Widen<
  AgentRow,
  | "name"
  | "description"
  | "harness"
  | "harnessVersion"
  | "operatorId"
  | "tier"
  | "nativeTier"
  | "beltSize"
  | "beltMode"
  | "runs30d"
  | "spend30d"
  | "modelTier"
>;

export type RecordedAgentDetail = RecordedAgentRow & {
  identity: Widen<
    AgentDetail["identity"],
    "principalId" | "host" | "collectorVersion" | "deviceKey" | "firstFrameAt"
  >;
  credential: Widen<
    AgentDetail["credential"],
    "lastUsedAt" | "activeRunTokens"
  > | null;
  definition: null;
  budget: null;
  /**
   * Today's role names (`Agent Operator`), not the spec's dotted names. Null
   * for an agent that is only enrolled: roles are read through its definition.
   */
  roles: Array<{ role: string; resource: string | null }> | null;
};

export type RecordedToolbeltEntry = Omit<
  ToolbeltEntry,
  "tool" | "description" | "pinned"
> & {
  /** A kernel agent tool name (`list_agent_defs`): today's grants carry no version. */
  tool: string;
  description: string | null;
  pinned: null;
};

export type RecordedToolbelt = Omit<
  Toolbelt,
  "mode" | "entries" | "outside" | "registryVersions" | "fullBeltLimit"
> & {
  mode: null;
  entries: RecordedToolbeltEntry[];
  outside: null;
  registryVersions: null;
  fullBeltLimit: null;
};

export type RecordedIncident = Omit<
  Incident,
  "kind" | "severity" | "title" | "detail" | "resolution"
> & {
  /** `tacho.incidents.kind`: twelve collector kinds, four shared with the spec's. */
  kind: string;
  severity: number;
  title: null;
  detail: null;
  resolution: string | null;
};

// ---- Mappers -------------------------------------------------------------------

const iso = (d: Date): string => d.toISOString();

/**
 * The spec's four agent states from three stores. Retired wins, then a
 * suspension on the principal or the host; an agent with no live enrollment is
 * unenrolled. A paused host is still enrolled: pause is run control, not status.
 */
export function toAgentStatus(
  s: Pick<AgentSource, "definition" | "host" | "principal">,
): AgentStatus {
  if (s.definition?.status === "archived" || s.principal?.status === "deleted")
    return "retired";
  if (s.principal?.status === "suspended" || s.host?.status === "suspended")
    return "suspended";
  if (!s.host || s.host.status === "revoked") return "unenrolled";
  return "active";
}

/** The first harness the host enrolled with that the spec names. */
export function toHarness(host: HostSummary | null): Harness | null {
  for (const h of host?.harnesses ?? []) {
    const parsed = Harness.safeParse(h);
    if (parsed.success) return parsed.data;
  }
  return null;
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Up to two initials from a display name or an agent key's slug. */
export function initialsOf(label: string): string {
  const words = (label.split(".").at(-1) ?? label)
    .split(/[\s\-_]+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  const letters = words
    .slice(0, 2)
    .map((w) => Array.from(graphemes.segment(w))[0]?.segment.toUpperCase())
    .join("");
  return letters || "?";
}

/**
 * An https avatar is a photo. Anything else (none, or the designed
 * `avatar:v1:` emoji spec the view model has no kind for) draws initials.
 */
export function toAvatar(avatarUrl: string | null, label: string): Avatar {
  if (avatarUrl?.startsWith("https://"))
    return { kind: "photo", src: avatarUrl };
  return {
    kind: "initials",
    text: initialsOf(label),
    font: "sans",
    tone: "soft",
  };
}

export function toAgentRow(s: AgentSource): RecordedAgentRow {
  const harness = toHarness(s.host);
  const def = s.definition;
  return {
    key: s.key,
    name: def?.name ?? null,
    description: def ? (def.description ?? def.summary ?? "") : null,
    harness,
    harnessVersion:
      harness === "claude-code"
        ? (s.host?.claudeVersionAtEnroll ?? null)
        : null,
    workspaceSlug: s.workspaceSlug,
    operatorId: s.principal?.operatorPublicId ?? null,
    status: toAgentStatus(s),
    tier: s.latestTier,
    nativeTier: null,
    beltSize: null,
    beltMode: null,
    runs30d: null,
    spend30d: null,
    proven30d: null,
    productiveRatio: null,
    // `tacho.hosts.incidents_open` is the collector's own counter. An agent that
    // was never enrolled has no incident a collector could have opened.
    openIncidents: s.host?.incidentsOpen ?? 0,
    mandateIds: null,
    modelTier: null,
    avatar: toAvatar(def?.avatarUrl ?? null, def?.name ?? s.key),
  };
}

export function toAgentDetail(
  s: AgentSource,
  facts: HostFacts | null,
  assignments: readonly AgentRoleAssignmentRow[] | null,
): RecordedAgentDetail {
  const enrolled = s.host !== null && s.host.status !== "revoked";
  return {
    ...toAgentRow(s),
    identity: {
      principalId: s.principal?.publicId ?? null,
      host: s.host?.hostname ?? null,
      enrolled,
      collectorVersion: s.host?.wrapperVersion ?? null,
      deviceKey: facts?.deviceKeyFingerprint ?? null,
      firstFrameAt: facts?.firstSessionAt ? iso(facts.firstSessionAt) : null,
      replayGrade: null,
    },
    credential: facts?.apiKey
      ? {
          prefix: facts.apiKey.keyPrefix,
          issuedAt: iso(facts.apiKey.createdAt),
          lastUsedAt: facts.apiKey.lastUsedAt
            ? iso(facts.apiKey.lastUsedAt)
            : null,
          activeRunTokens: null,
        }
      : null,
    definition: null,
    budget: null,
    // A workspace-scoped assignment is not a resource narrowing; today's
    // assignments carry no resource.
    roles:
      assignments?.map((a) => ({ role: a.roleName, resource: null })) ?? null,
  };
}

/** Deny wins, then require_approval, then allow (spec §6.3). */
const DECISION_RANK: Record<IamRoleRow["grants"][number]["effect"], number> = {
  deny: 3,
  require_approval: 2,
  allow: 1,
};

/**
 * The belt the agent's roles grant: one entry per agent tool, decided by the
 * strongest effect across the roles it holds, citing the role that decides it.
 */
export function toToolbelt(
  agentKey: string,
  assignments: readonly AgentRoleAssignmentRow[],
  roles: readonly IamRoleRow[],
  describe: (tool: string) => string | null,
): RecordedToolbelt {
  const held = new Set(assignments.map((a) => a.roleId));
  const decided = new Map<
    string,
    { decision: BeltDecision; rank: number; rule: string }
  >();
  for (const role of roles) {
    if (!held.has(role.id)) continue;
    for (const grant of role.grants) {
      const rank = DECISION_RANK[grant.effect];
      const current = decided.get(grant.capability);
      if (!current || rank > current.rank)
        decided.set(grant.capability, {
          decision: grant.effect,
          rank,
          rule: role.name,
        });
    }
  }
  const entries = [...decided.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([tool, d]): RecordedToolbeltEntry => ({
        tool,
        description: describe(tool),
        decision: d.decision,
        rule: d.rule,
        // list_iam_roles returns no grant conditions.
        scope: null,
        pinned: null,
        // A role grant is never one of the searchable belt's meta-tools.
        meta: false,
        note: null,
      }),
    );
  return {
    agentKey,
    mode: null,
    entries,
    outside: null,
    registryVersions: null,
    fullBeltLimit: null,
  };
}

/**
 * The definition as `agent.definition.*` stores it: the config JSON is its
 * source. There is no git file yet, so path, digest, commit and branches are
 * null rather than a made-up path or sha.
 */
export function toAgentDefinition(
  agentKey: string,
  def: Pick<AgentDefinitionGetOutput, "config">,
): AgentDefinition {
  return {
    agentKey,
    path: null,
    digest: null,
    commitSha: null,
    source: JSON.stringify(def.config, null, 2),
    branches: null,
  };
}

export function toIncident(
  agentKey: string,
  row: IncidentRow,
): RecordedIncident {
  return {
    id: row.publicId,
    severity: row.severity,
    kind: row.kind,
    // The collector records a kind and evidence, no prose.
    title: null,
    at: iso(row.detectedAt),
    detectedBy: row.detectedBy,
    agentKey,
    runIds: row.sessionPublicId ? [row.sessionPublicId] : [],
    scope: row.hostname ?? agentKey,
    detail: null,
    resolution: row.resolutionNote,
    status: row.resolvedAt ? "resolved" : "open",
    ownerId: null,
    dueOn: null,
    closedAt: row.resolvedAt ? iso(row.resolvedAt) : null,
    closedBy: row.resolvedByPublicId,
  };
}

// ---- What a view model must carry before a method serves live -----------------

/**
 * The fields (dotted, array indices dropped) a schema rejects in a sample.
 * Empty means the schema carries everything the stores record.
 */
export function rejectedPaths(schema: z.ZodType, sample: unknown): string[] {
  const parsed = schema.safeParse(sample);
  if (parsed.success) return [];
  const paths = parsed.error.issues.map((issue) =>
    issue.path.filter((p) => typeof p === "string").join("."),
  );
  return [...new Set(paths)].sort();
}

const PROBE_KEY = "acme.core.release-manager";
const PROBE_AT = new Date("2026-09-11T09:14:02.000Z");

const PROBE_DEFINITION: DefinitionRow = {
  agentId: "agt_probe",
  publicId: "agt_probe",
  slug: "release-manager",
  agentKey: PROBE_KEY,
  name: "Release manager",
  description: null,
  avatarUrl: null,
  summary: null,
  agentType: "custom",
  status: "draft",
  deploymentStatus: "inactive",
  latestVersion: 1,
  managed: false,
  toolRefs: [],
};

const PROBE_HOST: HostSummary = {
  hostEnrollmentId: "tch_probe",
  agentKey: PROBE_KEY,
  hostname: "host",
  platform: "darwin",
  osUser: "user",
  status: "active",
  mode: "observe",
  harnesses: ["claude-code"],
  claudeVersionAtEnroll: null,
  wrapperVersion: null,
  managed: false,
  lastSeenAt: null,
  lastIngestAt: null,
  hooksOk: null,
  otelOk: null,
  spoolDepth: 0,
  sessionsCount: 0,
  unobservedSessionsCount: 0,
  incidentsOpen: 0,
  expiresAt: PROBE_AT.toISOString(),
  revokedAt: null,
  createdAt: PROBE_AT.toISOString(),
};

/** An agent defined but never enrolled, and one enrolled with no definition. */
const PROBE_SOURCES: AgentSource[] = [
  {
    key: PROBE_KEY,
    workspaceSlug: "core",
    definition: PROBE_DEFINITION,
    host: null,
    principal: null,
    latestTier: null,
  },
  {
    key: PROBE_KEY,
    workspaceSlug: "core",
    definition: null,
    host: PROBE_HOST,
    principal: null,
    latestTier: null,
  },
];

const PROBE_ASSIGNMENT: AgentRoleAssignmentRow = {
  assignmentId: "pra_probe",
  roleId: "rol_probe",
  roleName: "Agent Operator",
  scopeKind: "workspace",
  isSystemDefault: true,
  assignedAt: PROBE_AT.toISOString(),
  assignedBy: null,
  expiresAt: null,
  workspaceId: null,
};

const PROBE_INCIDENT: IncidentRow = {
  publicId: "tin_probe",
  kind: "hooks_removed",
  severity: 10,
  detectedAt: PROBE_AT,
  detectedBy: "collector",
  resolvedAt: null,
  resolutionNote: null,
  hostname: null,
  sessionPublicId: null,
  resolvedByPublicId: null,
};

/**
 * Rows the mappers produce from the least each store can hold: every nullable
 * column null, every collector incident kind. A method serves live once its
 * view-model schema accepts its probe.
 */
export const RECORDED_PROBES = {
  listAgents: PROBE_SOURCES.map(toAgentRow),
  getAgent: PROBE_SOURCES.map((s) =>
    toAgentDetail(s, null, s.definition ? [PROBE_ASSIGNMENT] : null),
  ),
  toolbelt: toToolbelt(
    PROBE_KEY,
    [PROBE_ASSIGNMENT],
    [
      {
        id: "rol_probe",
        name: "Agent Operator",
        description: null,
        scopeKind: "workspace",
        isSystemDefault: true,
        version: "1",
        memberCount: 1,
        grants: [{ capability: "list_agent_defs", effect: "allow" }],
      },
    ],
    () => null,
  ),
  incidents: TACHO_INCIDENT_KINDS.map((kind) =>
    toIncident(PROBE_KEY, { ...PROBE_INCIDENT, kind }),
  ),
} as const;
