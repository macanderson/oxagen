// toolbelt.test.ts — the per-tool belt decision the runtime and the console
// share (#2956, ADR-057). Each gate is exercised with the input that trips
// it and the rule it names; materialize-tools.test.ts holds the parity test
// that pins the runtime's listing to this function.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const pluginMocks = vi.hoisted(() => ({
  pluginForContract: vi.fn(
    (_name: string): { id: string } | undefined => undefined,
  ),
}));
vi.mock("@oxagen/oxagen/plugins", () => ({
  pluginForContract: pluginMocks.pluginForContract,
}));

import type { ActiveEmergencyDeny } from "@oxagen/iam";
import {
  createAgentRunResolution,
  type AgentAuthzSnapshot,
  type AgentRunIAMContext,
  type ResolveScope,
} from "@oxagen/oxagen/iam";
import type { RegistryCapability } from "../registry-loader";
import {
  decideCapabilityForBelt,
  decideMcpToolForBelt,
  type CapabilityBeltEnv,
} from "./toolbelt";

const cap = (over: Partial<RegistryCapability> & { name: string }) =>
  ({
    description: over.name,
    surfaces: ["agent"],
    input: z.object({}),
    mutates: false,
    ...over,
  }) as unknown as RegistryCapability;

const READ = cap({ name: "list_runs", agent: { riskLevel: "low" } });
const WRITE = cap({
  name: "delete_workspace",
  mutates: true,
  agent: { riskLevel: "high", requiresApproval: true },
});

/** A mutation with no approval flag of its own: the resolver alone decides it. */
const MUTATION = cap({
  name: "update_workspace",
  mutates: true,
  agent: { riskLevel: "medium" },
});

const scope: ResolveScope = {
  kind: "workspace",
  orgId: "org_1",
  workspaceId: "ws_1",
};

const AGENT_PRN = "prn_agent";
const HUMAN_PRN = "prn_human";

function snapshot(
  agentGrants: {
    capabilityId: string;
    effect: "allow" | "deny" | "require_approval";
  }[],
): AgentAuthzSnapshot {
  return {
    grants: [],
    policies: [],
    roles: [
      {
        id: "role_agent",
        name: "Agent",
        scopeKind: "workspace",
        orgId: "org_1",
        principalIds: [AGENT_PRN],
        isSystemDefault: true,
      },
      {
        id: "role_human",
        name: "Member",
        scopeKind: "workspace",
        orgId: "org_1",
        principalIds: [HUMAN_PRN],
        isSystemDefault: true,
      },
    ],
    roleGrants: [
      ...agentGrants.map((g) => ({ roleId: "role_agent", ...g })),
      {
        roleId: "role_human",
        capabilityId: READ.name,
        effect: "allow" as const,
      },
      {
        roleId: "role_human",
        capabilityId: WRITE.name,
        effect: "allow" as const,
      },
      {
        roleId: "role_human",
        capabilityId: MUTATION.name,
        effect: "allow" as const,
      },
    ],
  };
}

function agentRun(
  resolution?: AgentRunIAMContext["resolution"],
): AgentRunIAMContext {
  const run: AgentRunIAMContext = {
    principalKind: "agent",
    agentPrincipal: {
      id: AGENT_PRN,
      kind: "agent",
      orgId: "org_1",
      workspaceId: "ws_1",
    },
    humanPrincipal: {
      id: HUMAN_PRN,
      kind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
    },
    agentId: "agt_test",
    runId: "run_1",
  };
  if (resolution) run.resolution = resolution;
  return run;
}

function env(over: Partial<CapabilityBeltEnv> = {}): CapabilityBeltEnv {
  return {
    surfaces: ["agent"],
    agentRun: null,
    resolution: null,
    scope,
    now: new Date("2026-09-14T10:00:00.000Z"),
    clientIp: null,
    emergencyDenies: [],
    entitledPluginIds: new Set<string>(),
    ...over,
  };
}

describe("decideCapabilityForBelt", () => {
  beforeEach(() => {
    pluginMocks.pluginForContract.mockReturnValue(undefined);
  });

  it("allows a read with no run and carries its risk and read-only facts", () => {
    expect(decideCapabilityForBelt(READ, env())).toEqual({
      outcome: "allow",
      rule: "contract_default",
      riskLevel: "low",
      readOnly: true,
    });
  });

  it("a contract that asks for approval is require_approval by its own flag", () => {
    expect(decideCapabilityForBelt(WRITE, env())).toMatchObject({
      outcome: "require_approval",
      rule: "contract_approval",
      riskLevel: "high",
      readOnly: false,
    });
  });

  it("denies a tool off the agent surface, an excluded one, one outside the allowlist and one over the risk ceiling, naming the gate", () => {
    expect(decideCapabilityForBelt(READ, env({ surfaces: ["api"] })).rule).toBe(
      "surface",
    );
    expect(
      decideCapabilityForBelt(READ, env({ excluded: new Set([READ.name]) }))
        .rule,
    ).toBe("excluded_this_turn");
    expect(
      decideCapabilityForBelt(READ, env({ allowlist: new Set([WRITE.name]) }))
        .rule,
    ).toBe("allowlist");
    expect(
      decideCapabilityForBelt(WRITE, env({ riskCeiling: "medium" })).rule,
    ).toBe("risk_ceiling");
    expect(
      decideCapabilityForBelt(READ, env({ riskCeiling: "low" })).outcome,
    ).toBe("allow");
  });

  it("fails closed for an agent run with no resolution", () => {
    expect(
      decideCapabilityForBelt(READ, env({ agentRun: agentRun() })),
    ).toMatchObject({
      outcome: "deny",
      rule: "agent_run_unresolved",
    });
  });

  it("decides the delegation ceiling from the run's resolution and names the deciding side and step", () => {
    const resolution = createAgentRunResolution(
      snapshot([
        { capabilityId: READ.name, effect: "allow" },
        { capabilityId: MUTATION.name, effect: "require_approval" },
      ]),
    );
    const run = agentRun(resolution);
    const read = decideCapabilityForBelt(
      READ,
      env({ agentRun: run, resolution }),
    );
    expect(read.outcome).toBe("allow");
    expect(read.rule).toMatch(/^(agent|human):/);
    const write = decideCapabilityForBelt(
      MUTATION,
      env({ agentRun: run, resolution }),
    );
    expect(write.outcome).toBe("require_approval");
    expect(write.rule).toMatch(/^agent:/);
    // No agent grant and no contract default: the kernel's deny fallback.
    const ungranted = decideCapabilityForBelt(
      cap({ name: "unseen" }),
      env({ agentRun: run, resolution }),
    );
    expect(ungranted.outcome).toBe("deny");
    expect(ungranted.rule).toMatch(/^agent:/);
  });

  it("an active emergency deny naming the capability, or the agent's principal, cuts the tool as kill_switch", () => {
    const resolution = createAgentRunResolution(
      snapshot([{ capabilityId: READ.name, effect: "allow" }]),
    );
    const run = agentRun(resolution);
    const byCapability: ActiveEmergencyDeny = {
      publicId: "edn_1",
      denyKind: "capability",
      capabilityId: READ.name,
      resourceScopeDigest: null,
      principalId: null,
      reason: "incident",
    };
    expect(
      decideCapabilityForBelt(
        READ,
        env({ agentRun: run, resolution, emergencyDenies: [byCapability] }),
      ),
    ).toMatchObject({ outcome: "deny", rule: "kill_switch" });
    const otherPrincipal = { ...byCapability, principalId: "prn_someone_else" };
    expect(
      decideCapabilityForBelt(
        READ,
        env({ agentRun: run, resolution, emergencyDenies: [otherPrincipal] }),
      ).outcome,
    ).toBe("allow");
  });

  it("a plugin-claimed contract needs the plugin entitled, and an unavailable read fails closed", () => {
    pluginMocks.pluginForContract.mockReturnValue({ id: "plg_github" });
    expect(decideCapabilityForBelt(READ, env()).rule).toBe("entitlement");
    expect(
      decideCapabilityForBelt(READ, env({ entitledPluginIds: "unavailable" }))
        .rule,
    ).toBe("entitlement");
    expect(
      decideCapabilityForBelt(
        READ,
        env({ entitledPluginIds: new Set(["plg_github"]) }),
      ).outcome,
    ).toBe("allow");
  });
});

// The role rule (#4194). The kernel's IAM check allows every capability for a
// non-enterprise org, and each handler asks for its contract's roles, so a
// person's belt holds only what their roles are granted.
describe("decideCapabilityForBelt role rule", () => {
  const OWNER_ONLY = cap({
    name: "install_plugin",
    mutates: true,
    agent: { riskLevel: "medium" },
    defaultRoles: {
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow" },
    },
  });
  const MEMBERS = cap({
    name: "get_rate_card",
    defaultRoles: {
      org: { Owner: "allow", Admin: "allow", Billing: "allow" },
      workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
    },
  });
  const MEMBER = { org: [], workspace: ["Member"] };
  const ORG_OWNER = { org: ["Owner"], workspace: [] };

  beforeEach(() => {
    pluginMocks.pluginForContract.mockReturnValue(undefined);
  });

  it("drops an Owner-only capability from a workspace Member's belt", () => {
    expect(
      decideCapabilityForBelt(OWNER_ONLY, env({ callerRoles: MEMBER })),
    ).toMatchObject({ outcome: "deny", rule: "role" });
  });

  it("keeps it on an org Owner's belt", () => {
    expect(
      decideCapabilityForBelt(OWNER_ONLY, env({ callerRoles: ORG_OWNER })),
    ).toMatchObject({ outcome: "allow", rule: "contract_default" });
  });

  it("keeps it for a workspace Owner, whom the contract's workspace side grants", () => {
    expect(
      decideCapabilityForBelt(
        OWNER_ONLY,
        env({ callerRoles: { org: [], workspace: ["Owner"] } }),
      ).outcome,
    ).toBe("allow");
  });

  it("keeps a capability the contract grants a workspace Member", () => {
    expect(
      decideCapabilityForBelt(MEMBERS, env({ callerRoles: MEMBER })).outcome,
    ).toBe("allow");
  });

  it("does not count an org role on the workspace side", () => {
    // "Owner" is granted on the workspace side only as a workspace role.
    const wsOnly = cap({
      name: "add_plugin_registry",
      defaultRoles: { org: {}, workspace: { Owner: "allow" } },
    });
    expect(
      decideCapabilityForBelt(wsOnly, env({ callerRoles: ORG_OWNER })).rule,
    ).toBe("role");
  });

  it("does not treat require_approval as a grant", () => {
    const asks = cap({
      name: "rotate_key",
      defaultRoles: { org: { Owner: "require_approval" }, workspace: {} },
    });
    expect(
      decideCapabilityForBelt(asks, env({ callerRoles: ORG_OWNER })).rule,
    ).toBe("role");
  });

  it("fails closed when the role read failed", () => {
    expect(
      decideCapabilityForBelt(MEMBERS, env({ callerRoles: "unavailable" })),
    ).toMatchObject({ outcome: "deny", rule: "role" });
  });

  it("does not apply when no roles were read", () => {
    expect(decideCapabilityForBelt(OWNER_ONLY, env()).outcome).toBe("allow");
  });

  it("leaves an agent run to its delegation ceiling", () => {
    // The run has no resolution, so the ceiling's own fail-closed rule
    // decides, not the role rule.
    expect(
      decideCapabilityForBelt(
        OWNER_ONLY,
        env({ agentRun: agentRun(), callerRoles: MEMBER }),
      ).rule,
    ).toBe("agent_run_unresolved");
  });
});

describe("decideMcpToolForBelt", () => {
  const decide = (effect: "allow" | "deny" | "ask") => () => effect;

  it("a deny rule hides the tool; an allow rule keeps it, naming whether a rule or the absence of one decided", () => {
    expect(
      decideMcpToolForBelt("github", "create_release", {
        mcpScope: undefined,
        consent: null,
        decide: decide("deny"),
      }),
    ).toMatchObject({ outcome: "deny", rule: "mcp_rule" });
    expect(
      decideMcpToolForBelt("github", "search", {
        mcpScope: undefined,
        consent: null,
        decide: decide("allow"),
      }),
    ).toMatchObject({ outcome: "allow", rule: "mcp_unrestricted" });
    expect(
      decideMcpToolForBelt("github", "search", {
        mcpScope: { rules: [] } as never,
        consent: null,
        decide: decide("allow"),
      }).rule,
    ).toBe("mcp_rule");
  });

  it("an ask rule routes through standing consent: granted allows, denied hides, none asks at first use", () => {
    const base = { mcpScope: undefined, decide: decide("ask") };
    expect(
      decideMcpToolForBelt("github", "merge", {
        ...base,
        consent: { status: "granted" },
      }),
    ).toMatchObject({ outcome: "allow", rule: "consent" });
    expect(
      decideMcpToolForBelt("github", "merge", {
        ...base,
        consent: { status: "denied" },
      }),
    ).toMatchObject({ outcome: "deny", rule: "consent" });
    expect(
      decideMcpToolForBelt("github", "merge", { ...base, consent: null }),
    ).toMatchObject({ outcome: "require_approval", rule: "mcp_rule_ask" });
  });
});
