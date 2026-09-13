import { TACHO_INCIDENT_KINDS } from "@oxagen/database/schema";
import type { AgentRoleAssignmentRow } from "@oxagen/oxagen/contracts/agent.role.list";
import type { IamRoleRow } from "@oxagen/oxagen/contracts/iam.role.list";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentDefinition,
  AgentDetail,
  AgentRow,
  Incident,
  IncidentKind,
  Toolbelt,
} from "@/data/contracts";
import {
  type AgentSource,
  type DefinitionRow,
  type HostFacts,
  type HostSummary,
  type IncidentRow,
  initialsOf,
  RECORDED_PROBES,
  rejectedPaths,
  toAgentDefinition,
  toAgentDetail,
  toAgentRow,
  toAgentStatus,
  toAvatar,
  toHarness,
  toIncident,
  toToolbelt,
} from "./agents";

// Rows as the local stack holds them (agent.agents + iam.principals + auth.users
// for "Grid Proof Agent", its Agent Contributor assignment). The host and the
// incident follow tacho.hosts / tacho.incidents column for column; the local
// stack has not enrolled a host yet.
const DEFINITION: DefinitionRow = {
  agentId: "agt_gmfc7dehp2p0mrgn1dks9w",
  publicId: "agt_gmfc7dehp2p0mrgn1dks9w",
  slug: "e2e-mt6jsb9g",
  agentKey: "e2eavg.defaul.e2e-mt6jsb9g",
  name: "Grid Proof Agent",
  description: null,
  avatarUrl: 'avatar:v1:{"emoji":"😀","bg":"#f97316","mode":"mono-light"}',
  summary: null,
  agentType: "custom",
  status: "draft",
  deploymentStatus: "inactive",
  latestVersion: 1,
  managed: false,
  toolRefs: [],
};

const HOST: HostSummary = {
  hostEnrollmentId: "tch_3pb7whjgdscp26005pstmb",
  agentKey: DEFINITION.agentKey ?? "",
  hostname: "mbell-mbp-16",
  platform: "darwin",
  osUser: "mbell",
  status: "active",
  mode: "enforce",
  harnesses: ["claude-code"],
  claudeVersionAtEnroll: "2.1.4",
  wrapperVersion: "1.6.2",
  managed: false,
  lastSeenAt: "2026-09-11T14:22:04.000Z",
  lastIngestAt: "2026-09-11T14:22:04.000Z",
  hooksOk: true,
  otelOk: true,
  spoolDepth: 0,
  sessionsCount: 212,
  unobservedSessionsCount: 0,
  incidentsOpen: 2,
  expiresAt: "2027-07-14T09:02:00.000Z",
  revokedAt: null,
  createdAt: "2026-07-14T09:02:00.000Z",
};

const PRINCIPAL = {
  publicId: "prn_cv6302ky39te607290f12d",
  status: "active",
  operatorPublicId: "usr_t8wwe2gvak6m36gayph0pq",
};

const ASSIGNMENT: AgentRoleAssignmentRow = {
  assignmentId: "pra_3pb7whjgdscp26005pstma",
  roleId: "rol_781349a15fcd455e0b2743",
  roleName: "Agent Contributor",
  scopeKind: "workspace",
  isSystemDefault: true,
  assignedAt: "2026-08-24T01:18:48.970Z",
  assignedBy: null,
  expiresAt: null,
  workspaceId: "f0db905d-48a0-47e2-a6fe-6f19658849ff",
};

const FACTS: HostFacts = {
  deviceKeyFingerprint: "ed25519:8c41f02b70",
  apiKey: {
    keyPrefix: "ox_tWtJtsloV",
    createdAt: new Date("2026-08-24T01:34:40.560Z"),
    lastUsedAt: null,
  },
  firstSessionAt: new Date("2026-03-02T14:22:07.000Z"),
};

const INCIDENT: IncidentRow = {
  publicId: "tin_5k2m9q4r7t1w3y6z8a0c2e",
  kind: "hooks_removed",
  severity: 10,
  detectedAt: new Date("2026-09-11T08:40:00.000Z"),
  detectedBy: "collector",
  resolvedAt: null,
  resolutionNote: null,
  hostname: "mbell-mbp-16",
  sessionPublicId: "tse_01k5rn2p8x4c6v9b3n5m7q",
  resolvedByPublicId: null,
};

const source = (over: Partial<AgentSource> = {}): AgentSource => ({
  key: DEFINITION.agentKey ?? "",
  workspaceSlug: "default",
  definition: DEFINITION,
  host: null,
  principal: PRINCIPAL,
  latestTier: null,
  ...over,
});

const role = (
  id: string,
  name: string,
  grants: IamRoleRow["grants"],
): IamRoleRow => ({
  id,
  name,
  description: null,
  scopeKind: "workspace",
  isSystemDefault: true,
  version: "1",
  memberCount: 1,
  grants,
});

describe("toAgentStatus", () => {
  it("retires an archived definition or a deleted principal", () => {
    expect(
      toAgentStatus(
        source({ definition: { ...DEFINITION, status: "archived" } }),
      ),
    ).toBe("retired");
    expect(
      toAgentStatus(
        source({ host: HOST, principal: { ...PRINCIPAL, status: "deleted" } }),
      ),
    ).toBe("retired");
  });

  it("suspends on a suspended principal or host", () => {
    expect(
      toAgentStatus(
        source({ principal: { ...PRINCIPAL, status: "suspended" } }),
      ),
    ).toBe("suspended");
    expect(
      toAgentStatus(source({ host: { ...HOST, status: "suspended" } })),
    ).toBe("suspended");
  });

  it("is unenrolled with no host or a revoked one, never active", () => {
    expect(toAgentStatus(source())).toBe("unenrolled");
    expect(
      toAgentStatus(source({ host: { ...HOST, status: "revoked" } })),
    ).toBe("unenrolled");
  });

  it("is active on a live or paused enrollment", () => {
    expect(toAgentStatus(source({ host: HOST }))).toBe("active");
    expect(toAgentStatus(source({ host: { ...HOST, status: "paused" } }))).toBe(
      "active",
    );
  });
});

describe("harness, initials and avatar", () => {
  it("takes the first harness the spec names, and null for none", () => {
    expect(toHarness(HOST)).toBe("claude-code");
    expect(toHarness({ ...HOST, harnesses: ["vim", "claude-code"] })).toBe(
      "claude-code",
    );
    expect(toHarness({ ...HOST, harnesses: ["vim"] })).toBeNull();
    expect(toHarness(null)).toBeNull();
  });

  it("draws up to two initials from a name or a key's slug", () => {
    expect(initialsOf("Grid Proof Agent")).toBe("GP");
    expect(initialsOf("acme.core.release-manager")).toBe("RM");
    expect(initialsOf("émile")).toBe("É");
    expect(initialsOf("— —")).toBe("?");
  });

  it("uses an https avatar as a photo and draws initials for anything else", () => {
    expect(toAvatar("https://cdn.example/a.png", "x")).toEqual({
      kind: "photo",
      src: "https://cdn.example/a.png",
    });
    expect(toAvatar(DEFINITION.avatarUrl, "Grid Proof Agent")).toEqual({
      kind: "initials",
      text: "GP",
      font: "sans",
      tone: "soft",
    });
    expect(toAvatar("http://insecure.example/a.png", "Ada")).toMatchObject({
      kind: "initials",
    });
  });
});

describe("toAgentRow", () => {
  it("leaves every unrecorded field null for a defined, unenrolled agent", () => {
    const row = toAgentRow(source());
    expect(row).toMatchObject({
      key: "e2eavg.defaul.e2e-mt6jsb9g",
      name: "Grid Proof Agent",
      description: "",
      harness: null,
      harnessVersion: null,
      operatorId: "usr_t8wwe2gvak6m36gayph0pq",
      status: "unenrolled",
      tier: null,
      nativeTier: null,
      beltSize: null,
      beltMode: null,
      runs30d: null,
      spend30d: null,
      proven30d: null,
      productiveRatio: null,
      openIncidents: 0,
      mandateIds: null,
      modelTier: null,
    });
  });

  it("prefers the written description, then the summary", () => {
    expect(
      toAgentRow(
        source({ definition: { ...DEFINITION, summary: "Summarised" } }),
      ).description,
    ).toBe("Summarised");
    expect(
      toAgentRow(
        source({
          definition: { ...DEFINITION, description: "Written", summary: "S" },
        }),
      ).description,
    ).toBe("Written");
  });

  it("reads harness, version, tier and the incident counter from the enrollment", () => {
    const row = toAgentRow(source({ host: HOST, latestTier: "harness" }));
    expect(row).toMatchObject({
      harness: "claude-code",
      harnessVersion: "2.1.4",
      tier: "harness",
      status: "active",
      openIncidents: 2,
    });
  });

  it("names an enrolled-only agent by nothing it did not record", () => {
    const row = toAgentRow(
      source({ definition: null, principal: null, host: HOST }),
    );
    expect(row.name).toBeNull();
    expect(row.description).toBeNull();
    expect(row.operatorId).toBeNull();
    expect(row.avatar).toMatchObject({ kind: "initials", text: "EM" });
  });

  it("does not attach a claude-code version to another harness", () => {
    expect(
      toAgentRow(source({ host: { ...HOST, harnesses: ["custom"] } }))
        .harnessVersion,
    ).toBeNull();
  });
});

describe("toAgentDetail", () => {
  it("maps identity, the host credential (never its hash) and role assignments", () => {
    const detail = toAgentDetail(source({ host: HOST }), FACTS, [ASSIGNMENT]);
    expect(detail.identity).toEqual({
      principalId: "prn_cv6302ky39te607290f12d",
      host: "mbell-mbp-16",
      enrolled: true,
      collectorVersion: "1.6.2",
      deviceKey: "ed25519:8c41f02b70",
      firstFrameAt: "2026-03-02T14:22:07.000Z",
      replayGrade: null,
    });
    expect(detail.credential).toEqual({
      prefix: "ox_tWtJtsloV",
      issuedAt: "2026-08-24T01:34:40.560Z",
      lastUsedAt: null,
      activeRunTokens: null,
    });
    expect(detail.definition).toBeNull();
    expect(detail.budget).toBeNull();
    expect(detail.roles).toEqual([
      { role: "Agent Contributor", resource: null },
    ]);
  });

  it("records a used credential's last use", () => {
    const used = new Date("2026-09-11T14:22:04.000Z");
    const detail = toAgentDetail(
      source({ host: HOST }),
      { ...FACTS, apiKey: { ...FACTS.apiKey!, lastUsedAt: used } },
      [],
    );
    expect(detail.credential?.lastUsedAt).toBe("2026-09-11T14:22:04.000Z");
  });

  it("has no identity facts, credential or roles it could not read", () => {
    const detail = toAgentDetail(
      source({ principal: null, host: { ...HOST, status: "revoked" } }),
      { ...FACTS, apiKey: null, firstSessionAt: null },
      null,
    );
    expect(detail.identity).toMatchObject({
      principalId: null,
      enrolled: false,
      firstFrameAt: null,
    });
    expect(detail.credential).toBeNull();
    expect(detail.roles).toBeNull();
    expect(toAgentDetail(source(), null, []).identity).toMatchObject({
      host: null,
      deviceKey: null,
      collectorVersion: null,
    });
  });
});

describe("toToolbelt", () => {
  const held = [
    ASSIGNMENT,
    { ...ASSIGNMENT, roleId: "rol_operator", roleName: "Agent Operator" },
  ];
  const roles = [
    role("rol_781349a15fcd455e0b2743", "Agent Contributor", [
      { capability: "resolve_approval", effect: "allow" },
      { capability: "list_agent_defs", effect: "allow" },
      { capability: "start_background_task", effect: "require_approval" },
    ]),
    role("rol_operator", "Agent Operator", [
      { capability: "resolve_approval", effect: "deny" },
      { capability: "start_background_task", effect: "allow" },
    ]),
    role("rol_not_held", "Agent Observer", [
      { capability: "execute_code", effect: "allow" },
    ]),
  ];
  const describe_ = (tool: string) =>
    tool === "list_agent_defs" ? "List the agent definitions" : null;

  it("decides each tool by its strongest grant and cites the deciding role", () => {
    const belt = toToolbelt(
      "e2eavg.defaul.e2e-mt6jsb9g",
      held,
      roles,
      describe_,
    );
    expect(belt.entries.map((e) => [e.tool, e.decision, e.rule])).toEqual([
      ["list_agent_defs", "allow", "Agent Contributor"],
      ["resolve_approval", "deny", "Agent Operator"],
      ["start_background_task", "require_approval", "Agent Contributor"],
    ]);
  });

  it("never grants from a role the agent does not hold", () => {
    const belt = toToolbelt("k", held, roles, describe_);
    expect(belt.entries.some((e) => e.tool === "execute_code")).toBe(false);
    expect(toToolbelt("k", [], roles, describe_).entries).toEqual([]);
  });

  it("leaves what grants do not record null", () => {
    const belt = toToolbelt("k", held, roles, describe_);
    expect(belt).toMatchObject({
      mode: null,
      outside: null,
      registryVersions: null,
      fullBeltLimit: null,
    });
    expect(belt.entries[0]).toMatchObject({
      description: "List the agent definitions",
      scope: null,
      pinned: null,
      meta: false,
      note: null,
    });
    expect(belt.entries[1]?.description).toBeNull();
  });
});

describe("toAgentDefinition", () => {
  it("serves the DB-backed config as the source, with no git path, digest or commit", () => {
    const config = {
      graph: {
        mode: "read",
        budget: { maxHops: 2, maxNodes: 40 },
        retrieval: { strategy: "hybrid" },
        ontologyId: "",
      },
      agentTools: [],
    };
    const def = AgentDefinition.parse(
      toAgentDefinition("e2eavg.defaul.e2e-mt6jsb9g", { config } as never),
    );
    expect(def).toEqual({
      agentKey: "e2eavg.defaul.e2e-mt6jsb9g",
      path: null,
      digest: null,
      commitSha: null,
      source: JSON.stringify(config, null, 2),
      branches: null,
    });
  });
});

describe("toIncident", () => {
  it("maps an open collector incident with its run and host", () => {
    expect(toIncident("e2eavg.defaul.e2e-mt6jsb9g", INCIDENT)).toEqual({
      id: "tin_5k2m9q4r7t1w3y6z8a0c2e",
      severity: 10,
      kind: "hooks_removed",
      title: null,
      at: "2026-09-11T08:40:00.000Z",
      detectedBy: "collector",
      agentKey: "e2eavg.defaul.e2e-mt6jsb9g",
      runIds: ["tse_01k5rn2p8x4c6v9b3n5m7q"],
      scope: "mbell-mbp-16",
      detail: null,
      resolution: null,
      status: "open",
      ownerId: null,
      dueOn: null,
      closedAt: null,
      closedBy: null,
    });
  });

  it("maps a resolved incident with no host or run", () => {
    const resolved = toIncident("k.k.k", {
      ...INCIDENT,
      hostname: null,
      sessionPublicId: null,
      resolvedAt: new Date("2026-09-11T10:00:00.000Z"),
      resolutionNote: "Hooks restored by the operator.",
      resolvedByPublicId: "prn_cv6302ky39te607290f12d",
    });
    expect(resolved).toMatchObject({
      scope: "k.k.k",
      runIds: [],
      status: "resolved",
      resolution: "Hooks restored by the operator.",
      closedAt: "2026-09-11T10:00:00.000Z",
      closedBy: "prn_cv6302ky39te607290f12d",
    });
  });
});

describe("rejectedPaths", () => {
  it("is empty when the schema accepts the sample", () => {
    expect(rejectedPaths(z.object({ a: z.string() }), { a: "x" })).toEqual([]);
  });

  it("names each rejected field once, dotted, without array indices", () => {
    const schema = z.array(
      z.object({ a: z.string(), b: z.object({ c: z.number() }) }),
    );
    expect(
      rejectedPaths(schema, [
        { a: null, b: { c: "no" } },
        { a: null, b: { c: 1 } },
      ]),
    ).toEqual(["a", "b.c"]);
  });
});

// What today's view models refuse in rows the stores can hold. Each list is the
// promote request for c1: once a field accepts its recorded value the method
// serves live. A new rejection outside a list is a mapping regression.
describe("the view models against what the stores record", () => {
  const agentRowUnrecorded = [
    "beltMode",
    "beltSize",
    "description",
    "harness",
    "harnessVersion",
    "modelTier",
    "name",
    "nativeTier",
    "operatorId",
    "runs30d",
    "spend30d",
    "tier",
  ];

  it("AgentRow refuses only fields no store records", () => {
    const rejected = rejectedPaths(
      z.array(AgentRow),
      RECORDED_PROBES.listAgents,
    );
    expect(agentRowUnrecorded).toEqual(expect.arrayContaining(rejected));
  });

  it("AgentDetail refuses only unrecorded fields and today's role names", () => {
    const rejected = rejectedPaths(
      z.array(AgentDetail),
      RECORDED_PROBES.getAgent,
    );
    expect([
      ...agentRowUnrecorded,
      "identity.principalId",
      "identity.host",
      "identity.collectorVersion",
      "identity.deviceKey",
      "identity.firstFrameAt",
      "credential",
      "budget",
      "roles",
      "roles.role",
    ]).toEqual(expect.arrayContaining(rejected));
  });

  it("Toolbelt refuses only unversioned agent tools and belt facts no store records", () => {
    const rejected = rejectedPaths(Toolbelt, RECORDED_PROBES.toolbelt);
    expect([
      "mode",
      "entries.tool",
      "entries.description",
      "entries.pinned",
      "outside",
      "registryVersions",
      "fullBeltLimit",
    ]).toEqual(expect.arrayContaining(rejected));
  });

  it("Incident refuses only collector kinds and the prose the collector does not write", () => {
    const rejected = rejectedPaths(
      z.array(Incident),
      RECORDED_PROBES.incidents,
    );
    expect(["kind", "title", "detail", "resolution"]).toEqual(
      expect.arrayContaining(rejected),
    );
  });

  it("probes every collector incident kind, including those the spec lacks", () => {
    expect(RECORDED_PROBES.incidents.map((i) => i.kind)).toEqual([
      ...TACHO_INCIDENT_KINDS,
    ]);
    const missing = TACHO_INCIDENT_KINDS.filter(
      (k) => !IncidentKind.safeParse(k).success,
    );
    expect(missing).toEqual(
      expect.arrayContaining(["config_change", "daemon_down"]),
    );
  });
});
