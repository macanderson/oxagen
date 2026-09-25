/**
 * Every contract on the agent surface says whether it writes.
 *
 * `capabilityMutates` (../types.ts) reads a missing `mutates` flag as a
 * write. That default fails safe, but it hides what nobody decided: the
 * engine runs an undeclared read in series with every other call, and an
 * undeclared write looks the same as a declared one. So a contract on the
 * agent surface declares the flag, `true` or `false`, from what its handler
 * does. 105 of 205 agent contracts once left it out. This test reads every
 * registered contract, so the next one fails here instead of in review.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { INTERACTIVE_AGENT_CAPABILITIES } from "../interactive-agent";
import { getCapability, listCapabilities } from "../registry";
import { getSurfaces, type CapabilityDeclaration } from "../types";
import "../contracts.generated";

/**
 * Agent contracts allowed to leave `mutates` undeclared.
 *
 * Keep this empty. An entry needs a reviewed reason in a comment beside it:
 * who decided, where, and why the handler's effect cannot be stated.
 */
const EXEMPT: readonly string[] = [];

/** The names of agent contracts that leave `mutates` undeclared. */
function undeclaredMutates(caps: readonly CapabilityDeclaration[]): string[] {
  return caps
    .filter((cap) => getSurfaces(cap).includes("agent"))
    .filter((cap) => typeof cap.mutates !== "boolean")
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
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: {}, workspace: {} },
  input: z.object({}),
  output: z.object({}),
  ...overrides,
});

describe("agent contracts declare whether they write", () => {
  it("every registered agent contract declares `mutates`", () => {
    const offenders = undeclaredMutates(listCapabilities()).filter(
      (name) => !EXEMPT.includes(name),
    );
    expect(
      offenders,
      "Read each handler and set `mutates: true` if it writes anything, " +
        "`mutates: false` if it only reads, or add the name to EXEMPT " +
        "with a reviewed reason.",
    ).toEqual([]);
  });

  it("every exemption names a registered agent contract", () => {
    const undeclared = undeclaredMutates(listCapabilities());
    for (const name of EXEMPT) {
      expect(getCapability(name), `${name} is registered`).toBeDefined();
      expect(undeclared, `${name} still needs its exemption`).toContain(name);
    }
  });

  it("the assistant's pinned tools declare the writes they make", () => {
    const declared = Object.fromEntries(
      INTERACTIVE_AGENT_CAPABILITIES.map((name) => [
        name,
        getCapability(name)?.mutates,
      ]),
    );
    // recall_memory is the one that reads like a lookup and is not one: a
    // recall raises the recalled memories' confidence scores.
    expect(declared).toEqual({
      query_ontology: false,
      get_ontology_neighbors: false,
      recall_memory: true,
      save_memory: true,
      cite_reference: true,
      list_executions: false,
      get_execution_trace: false,
    });
  });
});

describe("the undeclared check", () => {
  it("reports an agent contract with no `mutates` flag", () => {
    const caps = [
      contract("write_unset", { surfaces: ["api", "agent"] }),
      contract("read_unset", { surfaces: ["agent"], mutates: undefined }),
    ];
    expect(undeclaredMutates(caps)).toEqual(["read_unset", "write_unset"]);
  });

  it("passes a declared read, a declared write, and an off-agent contract", () => {
    const caps = [
      contract("read_declared", { surfaces: ["agent"], mutates: false }),
      contract("write_declared", { surfaces: ["agent"], mutates: true }),
      // No `surfaces` means the default pair, api and mcp.
      contract("off_agent_unset", {}),
    ];
    expect(undeclaredMutates(caps)).toEqual([]);
  });
});
