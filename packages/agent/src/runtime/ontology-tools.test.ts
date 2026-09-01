/**
 * The ontology read set, held to its promises.
 *
 * The first half drives the admission rules with fixtures — the guard that
 * fails if a capability which writes, or is merely dangerous, is ever added to
 * this auto-granted list. The second half runs it
 * against the REAL registry, which is the part every other test in this
 * directory cannot do: they `vi.mock("@oxagen/oxagen")` away the contracts, so
 * nothing in the tree noticed whether a graph read was still registered, still
 * on the agent surface, or still read-only.
 */
import { describe, expect, it } from "vitest";
import type { RegistryCapability } from "../registry-loader";
import {
  assertOntologyReadOnly,
  isOntologyReadCapability,
  ONTOLOGY_READ_CAPABILITIES,
  OntologyReadSetError,
  ontologyReadViolation,
  ontologyReadViolations,
  withOntologyReads,
} from "./ontology-tools";

// An honest read under the post-#2600 model: it says so. Before that bit
// existed, "low risk + no approval" WAS how a read declared itself, and this
// fixture carried no `mutates` — which made it a write the moment the default
// flipped, and every test using it meaningless in a way that still passed
// locally.
const READ: RegistryCapability = {
  name: "irrelevant",
  description: "a graph read",
  mutates: false,
  agent: { riskLevel: "low", requiresApproval: false },
  sensitivity: "low",
};

/** Every declared name resolves to a plain low-risk read. */
const allRead = (): RegistryCapability => READ;

describe("ontologyReadViolation — the admission rules", () => {
  it("admits a low-risk read verb", () => {
    expect(ontologyReadViolation("query_ontology", READ)).toBeNull();
  });

  it("rejects a capability the registry no longer has", () => {
    const violation = ontologyReadViolation("query_ontology", undefined);
    expect(violation?.reason).toContain("not registered");
  });

  // Each of these spreads READ, so it carries `mutates: false` and passes the
  // mutation check. They are rejected by the RISK rule instead — which is the
  // sharper test: it proves danger alone bars a capability from an
  // auto-granted set even when its own mutation bit says it only reads.
  it.each([
    ["destructive sensitivity", { ...READ, sensitivity: "destructive" }],
    ["high agent risk", { ...READ, agent: { riskLevel: "high" } }],
    ["an approval requirement", { ...READ, agent: { requiresApproval: true } }],
  ] as const)("rejects a capability declaring %s", (_label, cap) => {
    const violation = ontologyReadViolation(
      "query_ontology",
      cap as RegistryCapability,
    );
    expect(violation?.reason).toContain("risk-shaped");
  });

  it("rejects a capability that declares nothing about mutating", () => {
    // The fail-safe default reaching this guard: absent means writing, so an
    // undeclared capability cannot enter the set by omission.
    const { mutates: _drop, ...undeclared } = READ;
    const violation = ontologyReadViolation(
      "query_ontology",
      undeclared as RegistryCapability,
    );
    expect(violation?.reason).toContain("does not declare `mutates: false`");
  });

  it("refuses a destructive capability that claims mutates: false", () => {
    // Contradictory metadata. For a set granted without anyone naming its
    // members, the safe reading is to disbelieve the reassuring half.
    const violation = ontologyReadViolation("query_ontology", {
      ...READ,
      mutates: false,
      sensitivity: "destructive",
    } as RegistryCapability);
    expect(violation?.reason).toContain("risk-shaped");
  });

  it("rejects a mutating verb even when the metadata says low risk", () => {
    // The hole the metadata checks alone leave: a delete that declares itself
    // a harmless read. Both the mutation bit and the risk grade pass it; the
    // verb does not.
    const violation = ontologyReadViolation("delete_node", READ);
    expect(violation?.reason).toContain("not a read verb");
  });

  it.each(["create_node", "update_node", "set_node_label", "run_cypher"])(
    "rejects the write-shaped name %s",
    (name) => {
      expect(ontologyReadViolation(name, READ)).not.toBeNull();
    },
  );
});

describe("the declared set", () => {
  it("is read-only under the rule", () => {
    expect(ontologyReadViolations(allRead)).toEqual([]);
    expect(() => assertOntologyReadOnly(allRead)).not.toThrow();
  });

  it("names every capability it declares, with no duplicates", () => {
    expect(new Set(ONTOLOGY_READ_CAPABILITIES).size).toBe(
      ONTOLOGY_READ_CAPABILITIES.length,
    );
  });

  it("reports every violation at once rather than the first", () => {
    // A caller fixing the set should see the whole list, not peel it one
    // failed run at a time.
    const broken = (name: string): RegistryCapability | undefined =>
      name === "query_ontology" || name === "search_graph" ? undefined : READ;
    const error = (() => {
      try {
        assertOntologyReadOnly(broken);
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(OntologyReadSetError);
    expect((error as OntologyReadSetError).violations).toHaveLength(2);
  });

  it("recognises its own members and nothing else", () => {
    expect(isOntologyReadCapability("query_ontology")).toBe(true);
    expect(isOntologyReadCapability("create_workspace")).toBe(false);
  });
});

describe("withOntologyReads — the per-run opt-in", () => {
  it("leaves an unnarrowed run alone", () => {
    // A run with no allowlist already materializes every agent-surface
    // capability. Handing it a concrete set would NARROW it to eight tools.
    expect(withOntologyReads(undefined, true)).toBeUndefined();
    expect(withOntologyReads(undefined, false)).toBeUndefined();
  });

  it("returns the caller's own set untouched when the run did not opt in", () => {
    const declared = new Set(["get_budget_policy"]);
    expect(withOntologyReads(declared, false)).toBe(declared);
  });

  it("unions the reads into a narrowed run that opted in", () => {
    const widened = withOntologyReads(new Set(["get_budget_policy"]), true);
    expect(widened?.has("get_budget_policy")).toBe(true);
    for (const name of ONTOLOGY_READ_CAPABILITIES) {
      expect(widened?.has(name)).toBe(true);
    }
  });

  it("does not mutate the allowlist it was given", () => {
    const declared = new Set(["get_budget_policy"]);
    withOntologyReads(declared, true);
    expect([...declared]).toEqual(["get_budget_policy"]);
  });
});

describe("against the real capability registry", () => {
  // Deliberately NOT mocked — this is the only test in this directory that
  // reads the contracts that actually ship.
  async function realLookup(): Promise<
    (name: string) => RegistryCapability | undefined
  > {
    const mod = await import("@oxagen/oxagen");
    return (name) =>
      mod.getCapability(name) as unknown as RegistryCapability | undefined;
  }

  it("every declared capability still carries the agent surface", async () => {
    // The guard that makes the declaration load-bearing rather than
    // documentary. `surfaces` is what decides whether materializeTools builds
    // a tool at all, so an edit dropping "agent" from one of these contracts
    // takes a graph read away from every agent on the platform — silently,
    // without this. Confirmed to fail for exactly that reason: dropping
    // "agent" from ontology.query.ts reports `query_ontology no longer reaches
    // an agent: expected [ 'api', 'mcp', 'cli' ] to include 'agent'`.
    //
    // The per-contract equivalent is agent.trace.get.test.ts's surfaces
    // assertion. This is the same idea keyed to the declared SET, so adding a
    // ninth read to ONTOLOGY_READ_CAPABILITIES inherits the guard.
    const mod = await import("@oxagen/oxagen");
    for (const name of ONTOLOGY_READ_CAPABILITIES) {
      const cap = mod.getCapability(name);
      expect(cap, `${name} is not registered`).toBeDefined();
      expect(
        mod.getSurfaces(cap!),
        `${name} no longer reaches an agent`,
      ).toContain("agent");
    }
  });

  it("every declared capability is registered and read-only", async () => {
    assertOntologyReadOnly(await realLookup());
  });

  it("no declared capability is classified mutating, so Stella may dispatch them concurrently", async () => {
    // The dispatch bit Stella reads is derived from this same classification
    // (materialize-tools' isMutatingCapability -> mutatingToolNames ->
    // tool-mapping's `read_only`). If one of these ever flipped, the reads
    // would serialize behind the exclusive barrier for no reason.
    const { isMutatingCapability } = await import("./materialize-tools");
    const mod = await import("@oxagen/oxagen");
    for (const name of ONTOLOGY_READ_CAPABILITIES) {
      const cap = mod.getCapability(name) as unknown as RegistryCapability;
      expect(isMutatingCapability(cap), `${name} is classified mutating`).toBe(
        false,
      );
    }
  });
});
