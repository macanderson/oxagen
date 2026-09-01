/**
 * The concurrency contract, held against the registry that actually ships.
 *
 * A capability marked `read_only` on the wire is a promise to the engine that
 * two calls to it in one step cannot interfere. Before #2600 that promise was
 * derived from `sensitivity`, `agent.riskLevel` and `agent.requiresApproval` —
 * three fields that grade how DANGEROUS a capability is — and 219 of the 271
 * capabilities offered to agents were making it on that basis.
 *
 * Every existing test of this classification mocks `@oxagen/oxagen` away, so
 * none of them could see a real contract. This one deliberately does not.
 */
import { describe, expect, it } from "vitest";
import {
  capabilityMutates,
  getSurfaces,
  listCapabilities,
  getCapability,
} from "@oxagen/oxagen";
import { isMutatingCapability } from "./materialize-tools";
import type { RegistryCapability } from "../registry-loader";

const agentCapabilities = (): RegistryCapability[] =>
  (listCapabilities() as unknown as RegistryCapability[]).filter((c) =>
    getSurfaces(c as never).includes("agent"),
  );

describe("capabilityMutates — the fail-safe default", () => {
  it("treats a capability that declares nothing as writing", () => {
    expect(capabilityMutates({})).toBe(true);
    expect(capabilityMutates({ mutates: undefined })).toBe(true);
  });

  it("only an explicit `false` buys concurrency", () => {
    expect(capabilityMutates({ mutates: false })).toBe(false);
    expect(capabilityMutates({ mutates: true })).toBe(true);
  });

  it("ignores how dangerous a capability is", () => {
    // The three fields the old classifier used. None of them is a claim about
    // writing, so none of them may move this answer either way.
    const dangerous = {
      mutates: false,
      sensitivity: "destructive",
      agent: { riskLevel: "high", requiresApproval: true },
    } as unknown as RegistryCapability;
    expect(capabilityMutates(dangerous)).toBe(false);

    const harmless = {
      sensitivity: "low",
      agent: { riskLevel: "low", requiresApproval: false },
    } as unknown as RegistryCapability;
    expect(capabilityMutates(harmless)).toBe(true);
  });
});

describe("one definition, two readers", () => {
  it("materializeTools' classifier is capabilityMutates, not a second copy", () => {
    // The engine's dispatch split and the registry guard must never be able to
    // disagree about one capability. Asserted over the real registry rather
    // than a fixture, so a divergence shows up on the contracts that ship.
    for (const cap of agentCapabilities()) {
      expect(
        isMutatingCapability(cap),
        `${cap.name} classifies differently in the two readers`,
      ).toBe(capabilityMutates(cap));
    }
  });
});

describe("against the real registry", () => {
  it("carries `mutates` through registration, so marking a contract is not inert", () => {
    // Not a tautology, unlike asserting that every concurrent capability
    // declares itself — `capabilityMutates` returns false ONLY for
    // `mutates === false`, so that set is empty by construction and the
    // assertion could never fail.
    //
    // This is the question that can actually go wrong: `registerCapability`
    // stores the declaration, and if it ever narrowed or rebuilt the object,
    // `mutates` would be dropped, every contract would read as undeclared, and
    // the whole surface would silently serialize. Safe, but the reclaim would
    // do nothing and nothing would say so.
    const declared = agentCapabilities().filter((c) => c.mutates === false);
    expect(
      declared.length,
      "no contract survives registration with mutates:false — the field is " +
        "being stripped between the contract and the registry",
    ).toBeGreaterThan(0);
    for (const cap of declared) {
      expect(capabilityMutates(cap), `${cap.name}`).toBe(false);
      expect(isMutatingCapability(cap), `${cap.name}`).toBe(false);
    }
  });

  it("recall_memory is not advertised as concurrent-safe", () => {
    // The witness. It declares sensitivity "low", riskLevel "low" and
    // requiresApproval false — the most harmless-looking contract in the
    // registry — and its handler runs three Neo4j writes, including
    // `m.citation_count = coalesce(m.citation_count, 0) + 1`. That read-modify-
    // write is precisely what two concurrent calls lose.
    // See packages/agent/src/handlers/agent.memory.recall.ts and
    // packages/agent/src/memory/neo4j.ts's recordCitation.
    const cap = getCapability("recall_memory") as unknown as RegistryCapability;
    expect(cap, "recall_memory is no longer registered").toBeDefined();
    // Asserted through the classifier the engine actually reads, so reverting
    // that function turns this red.
    expect(isMutatingCapability(cap)).toBe(true);
  });

  it("suggest_connection_mappings is not advertised as concurrent-safe", () => {
    // The second one a name-based rule gets wrong in the dangerous direction:
    // it reads as a pure suggestion and inserts setupSuggestions rows
    // (packages/handlers/src/connection.mappings.suggest.ts).
    const cap = getCapability(
      "suggest_connection_mappings",
    ) as unknown as RegistryCapability;
    expect(cap, "suggest_connection_mappings is no longer registered")
      .toBeDefined();
    expect(isMutatingCapability(cap)).toBe(true);
  });
});
