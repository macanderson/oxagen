/**
 * Tool-call reduction benchmark (success metric: >=50% fewer context-gathering
 * tool calls).
 *
 * For each representative coding task we spell out the MINIMUM plausible sequence
 * of primitive tool calls a grep/bash agent makes to assemble the context, then
 * run the SAME task through a single `graph_query` and assert the one call
 * actually returns the equivalent context (files + symbols + edges).
 *
 * The reduction figure is arithmetic over the hand-authored `baseline` table
 * against a constant one call — it quantifies the claim, it does not test the
 * implementation. The baseline sequences are deliberately conservative (every
 * entry is a distinct call a real agent genuinely issues) so the ratio is not
 * inflated, but only the `expectContext` assertions can actually fail on a
 * regression.
 */
import { describe, it, expect } from "vitest";
import {
  makeGraph,
  FakeEmbeddingClient,
  embedFixtureFiles,
} from "./fixtures.js";
import { runGraphQuery, type GraphContextResult } from "../graph-query.js";
import { DEFAULT_GRAPH_CONFIG } from "../config.js";

interface Scenario {
  task: string;
  /** The minimum grep/read/glob calls an agent needs WITHOUT the graph. */
  baseline: string[];
  run: () => Promise<GraphContextResult>;
  /** Assert the single graph_query returned the context the greps would gather. */
  expectContext: (r: GraphContextResult) => void;
}

const scenarios: Scenario[] = [
  {
    task: "Change the payment processor based on card type",
    baseline: [
      'grep "processPayment"', // locate the function
      "read_file processor.ts", // read its body
      'grep "processPayment("', // find callers
      "read_file checkout.ts", // confirm the caller
      'grep "routeByCardType|card type"', // find the routing it delegates to
      "read_file router.ts", // read routing logic
    ],
    run: () =>
      runGraphQuery({
        input: {
          query: "change the payment processor by card type",
          focusSymbols: ["processPayment"],
          flow: "both",
        },
        graph: makeGraph(),
        root: "/repo",
        client: null,
        config: DEFAULT_GRAPH_CONFIG,
      }),
    expectContext: (r) => {
      expect(r.impactedFiles.some((f) => f.path.endsWith("processor.ts"))).toBe(
        true,
      );
      expect(r.symbols.some((s) => s.name === "handleCheckout")).toBe(true); // caller
      expect(r.symbols.some((s) => s.name === "routeByCardType")).toBe(true); // callee
    },
  },
  {
    task: "Find all code related to telemetry drains",
    baseline: [
      'grep "telemetry"',
      'grep "drain"',
      "read_file telemetry/drain.ts",
      'glob "**/telemetry/**"',
    ],
    run: () => {
      const g = makeGraph();
      const client = new FakeEmbeddingClient();
      embedFixtureFiles(g, client);
      return runGraphQuery({
        input: { query: "telemetry drains" },
        graph: g,
        root: "/repo",
        client,
        config: DEFAULT_GRAPH_CONFIG,
      });
    },
    expectContext: (r) => {
      expect(r.impactedFiles[0]?.path).toBe("src/telemetry/drain.ts");
    },
  },
  {
    task: "What invokes processPayment?",
    baseline: ['grep "processPayment("', "read_file checkout.ts"],
    run: () =>
      runGraphQuery({
        input: {
          query: "processPayment",
          focusSymbols: ["processPayment"],
          flow: "callers",
        },
        graph: makeGraph(),
        root: "/repo",
        client: null,
        config: DEFAULT_GRAPH_CONFIG,
      }),
    expectContext: (r) => {
      expect(r.symbols.some((s) => s.name === "handleCheckout")).toBe(true);
    },
  },
];

/** One `graph_query` replaces the whole baseline sequence for a scenario. */
const GRAPH_CALLS_PER_SCENARIO = 1;

describe("graph_query tool-call reduction", () => {
  for (const s of scenarios) {
    it(`"${s.task}" — one graph_query returns the context the grep sequence would gather`, async () => {
      const result = await s.run();
      // The load-bearing assertion: the single call really does return the
      // files/symbols/edges the baseline greps were issued to find. The call
      // counts below are declared constants, so the ratio is arithmetic over
      // the scenario table — it proves the table, not the implementation.
      s.expectContext(result);

      const reduction =
        (s.baseline.length - GRAPH_CALLS_PER_SCENARIO) / s.baseline.length;
      expect(reduction).toBeGreaterThanOrEqual(0.5);
    });
  }

  it("aggregate reduction across the scenario table is >=50%", () => {
    // Derived from the table, not accumulated across the tests above — a
    // filtered or sharded run must not change this number.
    const totalBaseline = scenarios.reduce((n, s) => n + s.baseline.length, 0);
    const totalGraph = scenarios.length * GRAPH_CALLS_PER_SCENARIO;
    // 12 baseline calls → 3 graph_query calls = 75% fewer.
    expect((totalBaseline - totalGraph) / totalBaseline).toBeGreaterThanOrEqual(
      0.5,
    );
  });
});
