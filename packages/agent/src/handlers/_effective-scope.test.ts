// _effective-scope.test.ts — the run-constant resourceScope reader (Agent RBAC
// Phase 4b, spec §3.3).
//
// The case that matters is the EMPTY MEMO. This helper originally assumed the
// kernel had already resolved the invoked capability and left an entry on
// `resolution.byCapability`. The run-evidence work replaced the kernel's agent
// seam with the pinned ∩ live evaluator, which keys its own generation-scoped
// cache and never writes that memo — so the old assumption would have made
// every dimension gate downstream (skills, subagent refs) a silent
// pass-through. A widening is exactly the failure a test must catch, because
// "returns undefined" reads as "unrestricted" and never throws.

import { describe, expect, it, vi } from "vitest";

vi.mock("@oxagen/iam", () => ({ emitAudit: vi.fn(async () => undefined) }));

import {
  createAgentRunResolution,
  type AgentRunIAMContext,
} from "@oxagen/oxagen/iam";
import {
  effectiveResourceScope,
  RESOURCE_SCOPE_SENTINEL_CAPABILITY,
} from "./_effective-scope";
import type { CapabilityContext } from "../types";

const ORG_ID = "org_1";
const WS_ID = "ws_1";

const ctx: CapabilityContext = {
  orgId: ORG_ID,
  workspaceId: WS_ID,
  userId: "usr_1",
  apiKeyId: null,
  requestId: "req_1",
  surface: "runner",
  messageId: null,
  clientIp: null,
};

/** Both ceiling principals granted the same skills allow-list. */
function skillsScopedRun(slugs: string[]): AgentRunIAMContext {
  const agentRun: AgentRunIAMContext = {
    principalKind: "agent",
    agentPrincipal: {
      id: "prn_agent",
      kind: "agent",
      orgId: ORG_ID,
      workspaceId: WS_ID,
    },
    humanPrincipal: {
      id: "prn_human",
      kind: "human",
      orgId: ORG_ID,
      workspaceId: WS_ID,
    },
    agentId: "agt_1",
    runId: "run_1",
  };
  // resourceScope is collected per PRINCIPAL, not per capability, so the
  // capability id on the grant is irrelevant to what this helper reads back —
  // which is the property that makes an inert sentinel a sound probe.
  agentRun.resolution = createAgentRunResolution({
    grants: [
      {
        principalId: "prn_agent",
        capabilityId: RESOURCE_SCOPE_SENTINEL_CAPABILITY,
        scopeKind: "workspace",
        scopeId: WS_ID,
        effect: "allow",
        conditionsJsonb: { resourceScope: { skills: { slugs } } },
        expiresAt: null,
      },
      {
        principalId: "prn_human",
        capabilityId: RESOURCE_SCOPE_SENTINEL_CAPABILITY,
        scopeKind: "workspace",
        scopeId: WS_ID,
        effect: "allow",
        conditionsJsonb: { resourceScope: { skills: { slugs } } },
        expiresAt: null,
      },
    ],
    roles: [],
    roleGrants: [],
    policies: [],
  });
  return agentRun;
}

describe("effectiveResourceScope()", () => {
  it("returns undefined for a non-agent invocation (human / API key / service)", () => {
    expect(effectiveResourceScope(ctx)).toBeUndefined();
  });

  it("returns undefined when an agent run carries no resolution at all", () => {
    const agentRun = skillsScopedRun(["skill_a"]);
    delete agentRun.resolution;
    expect(effectiveResourceScope({ ...ctx, agentRun })).toBeUndefined();
  });

  it("resolves the scope from an EMPTY memo rather than reporting unrestricted", () => {
    const agentRun = skillsScopedRun(["skill_a"]);
    expect(agentRun.resolution?.byCapability.size).toBe(0);

    const scope = effectiveResourceScope({ ...ctx, agentRun });

    // The regression this pins: an empty memo used to yield `undefined`, which
    // every downstream dimension gate reads as "no restriction".
    expect(scope).toBeDefined();
    expect(scope?.skills?.slugs).toEqual(["skill_a"]);
  });

  it("memoizes the sentinel probe so a second read costs no second resolution", () => {
    const agentRun = skillsScopedRun(["skill_a"]);

    effectiveResourceScope({ ...ctx, agentRun });
    const afterFirst = agentRun.resolution?.byCapability.size;
    effectiveResourceScope({ ...ctx, agentRun });

    expect(afterFirst).toBe(1);
    expect(agentRun.resolution?.byCapability.size).toBe(1);
    expect(
      agentRun.resolution?.byCapability.has(RESOURCE_SCOPE_SENTINEL_CAPABILITY),
    ).toBe(true);
  });

  it("prefers an already-memoized entry over the sentinel probe", () => {
    const agentRun = skillsScopedRun(["skill_a"]);
    // Stand in for the entry a kernel check would have left behind, carrying a
    // DIFFERENT scope so the assertion can tell the two sources apart.
    const decidedBy = {
      rule: "test_fixture",
      description: "memoized by an earlier check",
      decided: true,
      outcome: "allow" as const,
    };
    const allow = {
      outcome: "allow" as const,
      trace: { steps: [decidedBy], decidedBy },
    };
    agentRun.resolution?.byCapability.set("list_skills", {
      outcome: "allow",
      agentResolution: allow,
      humanResolution: allow,
      resourceScope: { skills: { slugs: ["skill_from_memo"] } },
    });

    expect(effectiveResourceScope({ ...ctx, agentRun })?.skills?.slugs).toEqual(
      ["skill_from_memo"],
    );
    // No sentinel entry was added — the memo short-circuits before the probe.
    expect(
      agentRun.resolution?.byCapability.has(RESOURCE_SCOPE_SENTINEL_CAPABILITY),
    ).toBe(false);
  });

  it("uses an inert sentinel name no real contract can claim", () => {
    // If a contract ever took this name, the probe's memo entry would become a
    // real kernel decision made with defaultEffect "deny".
    expect(RESOURCE_SCOPE_SENTINEL_CAPABILITY).toBe("__run_resource_scope__");
  });
});
