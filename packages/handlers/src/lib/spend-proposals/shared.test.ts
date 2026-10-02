import { lineageIdSchema } from "@oxagen/oxagen/contracts/context.steering.shared";
import { describe, expect, it } from "vitest";
import { agentLineage, formatMicros, plural, proposalSource } from "./shared";

describe("agentLineage", () => {
  it("names a lineage the contract accepts for any agent key", () => {
    const lineage = agentLineage("spin_loops", "Acme_Org.core.Triage Bot");
    expect(lineage).toMatch(/^ctx\.spend\.spin-loops-[0-9a-f]{12}$/);
    expect(lineageIdSchema.safeParse(lineage).success).toBe(true);
  });

  it("names one lineage per agent and kind", () => {
    const triage = agentLineage("spin_loops", "acme.core.triage");
    expect(agentLineage("spin_loops", "acme.core.triage")).toBe(triage);
    expect(agentLineage("spin_loops", "acme.core.review")).not.toBe(triage);
    expect(agentLineage("model_class_fit", "acme.core.triage")).toMatch(
      /^ctx\.spend\.model-class-fit-/,
    );
  });
});

describe("formatMicros", () => {
  it("prints money to the cent", () => {
    expect(formatMicros(12_404_999n, "usd")).toBe("$12.40");
  });

  it("prints the code after the figure when Intl does not know it", () => {
    expect(formatMicros(1_000_000n, "not-a-code")).toBe("1.00 NOT-A-CODE");
  });
});

describe("plural and proposalSource", () => {
  it("count and name", () => {
    expect(plural(1, "run", "runs")).toBe("1 run");
    expect(plural(1200, "run", "runs")).toBe("1,200 runs");
    expect(proposalSource("spin_loops")).toBe("finding:spin_loops");
  });
});
