/**
 * A high-risk capability on the agent surface pauses for a person.
 *
 * `agent.requiresApproval` is enforced in one place: the tool gateway in
 * `packages/agent/src/runtime/materialize-tools.ts`, which parks the call on
 * an approval card before it reaches `invoke()`. The kernel never reads the
 * flag, so API and MCP calls are gated by IAM and the workspace's decision
 * rules alone. On the agent surface, a contract rated `riskLevel: "high"`
 * that leaves the flag off runs without a person seeing the call first.
 *
 * Four secret writes shipped that way (`import_env_secrets`,
 * `delete_secret_key`, `upsert_secret_key`, `set_secret_value`) while the
 * other 29 high-risk agent contracts set the flag. A fifth,
 * `unset_secret_value`, was rated medium and is now rated high with them.
 * This test reads every registered contract, so the next one fails here
 * instead of in review.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getCapability, listCapabilities } from "../registry";
import { getSurfaces, type CapabilityDeclaration } from "../types";
import "../contracts.generated";

/**
 * High-risk agent contracts allowed to run without approval.
 *
 * Keep this empty. An entry needs a reviewed reason in a comment beside it:
 * who decided, where, and why a person should not see the call first.
 */
const EXEMPT: readonly string[] = [];

/** The names of high-risk agent contracts that do not require approval. */
function unapprovedHighRisk(caps: readonly CapabilityDeclaration[]): string[] {
  return caps
    .filter((cap) => getSurfaces(cap).includes("agent"))
    .filter((cap) => cap.agent?.riskLevel === "high")
    .filter((cap) => cap.agent?.requiresApproval !== true)
    .map((cap) => cap.name)
    .sort();
}

const contract = (
  name: string,
  overrides: Partial<CapabilityDeclaration>,
): CapabilityDeclaration => ({
  name,
  domain: "test",
  description: "test capability",
  mode: "sync",
  layers: ["unit"],
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: {}, workspace: {} },
  input: z.object({}),
  output: z.object({}),
  ...overrides,
});

describe("high-risk agent contracts require approval", () => {
  it("every registered high-risk agent contract requires approval", () => {
    const offenders = unapprovedHighRisk(listCapabilities()).filter(
      (name) => !EXEMPT.includes(name),
    );
    expect(
      offenders,
      "Set `agent.requiresApproval: true` on these contracts, or add each " +
        "name to EXEMPT with a reviewed reason.",
    ).toEqual([]);
  });

  it("every exemption names a registered high-risk agent contract", () => {
    const unapproved = unapprovedHighRisk(listCapabilities());
    for (const name of EXEMPT) {
      expect(getCapability(name), `${name} is registered`).toBeDefined();
      expect(unapproved, `${name} still needs its exemption`).toContain(name);
    }
  });
});

describe("the invariant check", () => {
  it("reports a high-risk agent contract without approval", () => {
    const caps = [
      contract("write_unapproved", {
        surfaces: ["api", "agent"],
        agent: { riskLevel: "high", requiresApproval: false },
      }),
      contract("write_unset", {
        surfaces: ["agent"],
        agent: { riskLevel: "high" },
      }),
    ];
    expect(unapprovedHighRisk(caps)).toEqual([
      "write_unapproved",
      "write_unset",
    ]);
  });

  it("passes an approved, lower-risk, or off-agent contract", () => {
    const caps = [
      contract("write_approved", {
        surfaces: ["agent"],
        agent: { riskLevel: "high", requiresApproval: true },
      }),
      contract("write_medium", {
        surfaces: ["agent"],
        agent: { riskLevel: "medium", requiresApproval: false },
      }),
      // No `surfaces` means the default pair, api and mcp.
      contract("write_off_agent", {
        agent: { riskLevel: "high", requiresApproval: false },
      }),
    ];
    expect(unapprovedHighRisk(caps)).toEqual([]);
  });
});
