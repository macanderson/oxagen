/**
 * Shared fixtures for the context-layer tests: a small payment-domain code
 * graph and a deterministic fake embedding client (keyword-axis vectors) so the
 * semantic path is testable without the gateway.
 */
import type {
  CodeGraph,
  CodeNode,
  CodeEdge,
} from "../../../daemon/code-graph/types.js";
import type { EmbeddingClient } from "../embedding.js";

function file(id: string, path: string): CodeNode {
  return {
    id,
    kind: "file",
    name: path,
    path,
    range: { start: 1, end: 1 },
    language: "typescript",
  };
}
function fn(id: string, name: string, path: string, line: number): CodeNode {
  return {
    id,
    kind: "function",
    name,
    path,
    range: { start: line, end: line + 5 },
    language: "typescript",
  };
}

/**
 * Payment-domain fixture:
 *   checkout.ts:handleCheckout → processor.ts:processPayment → router.ts:routeByCardType
 *   telemetry/drain.ts:drainTelemetry (unrelated, for semantic separation)
 */
export function makeGraph(): CodeGraph {
  const F1 = file("F1", "src/payment/processor.ts");
  const F2 = file("F2", "src/payment/router.ts");
  const F3 = file("F3", "src/checkout/checkout.ts");
  const F4 = file("F4", "src/telemetry/drain.ts");
  const S1 = fn("S1", "processPayment", "src/payment/processor.ts", 10);
  const S2 = fn("S2", "routeByCardType", "src/payment/router.ts", 4);
  const S3 = fn("S3", "handleCheckout", "src/checkout/checkout.ts", 20);
  const S4 = fn("S4", "drainTelemetry", "src/telemetry/drain.ts", 8);

  const nodes = new Map<string, CodeNode>();
  for (const n of [F1, F2, F3, F4, S1, S2, S3, S4]) nodes.set(n.id, n);

  const edges: CodeEdge[] = [
    { source: "F1", target: "S1", type: "contains" },
    { source: "F2", target: "S2", type: "contains" },
    { source: "F3", target: "S3", type: "contains" },
    { source: "F4", target: "S4", type: "contains" },
    { source: "S3", target: "S1", type: "calls" }, // handleCheckout → processPayment
    { source: "S1", target: "S2", type: "calls" }, // processPayment → routeByCardType
    { source: "F3", target: "F1", type: "imports" }, // checkout imports processor
    { source: "F1", target: "F2", type: "imports" }, // processor imports router
  ];
  return { nodes, edges };
}

/** Keyword axes for the deterministic fake embedder. */
export const AXES = [
  "payment",
  "card",
  "checkout",
  "telemetry",
  "drain",
  "route",
];

function keywordVector(text: string): number[] {
  const lower = text.toLowerCase();
  return AXES.map((axis) => {
    const m = lower.match(new RegExp(axis, "g"));
    return m ? m.length : 0;
  });
}

/** A deterministic, offline embedding client for tests (keyword-count vectors). */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly providerId = "fake-v1";
  readonly dimensions = AXES.length;
  embedCalls = 0;
  async embed(text: string): Promise<number[]> {
    this.embedCalls++;
    return keywordVector(text);
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    this.embedCalls += texts.length;
    return texts.map(keywordVector);
  }
}

/** Pre-populate file-node embeddings so the semantic path reuses them (no I/O). */
export function embedFixtureFiles(
  graph: CodeGraph,
  client: FakeEmbeddingClient,
): void {
  const textFor: Record<string, string> = {
    F1: "src payment processor processPayment card",
    F2: "src payment router routeByCardType route card",
    F3: "src checkout handleCheckout",
    F4: "src telemetry drain drainTelemetry telemetry drain",
  };
  for (const [id, text] of Object.entries(textFor)) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    node.embedding = keywordVector(text);
    node.embeddingProvider = client.providerId;
  }
}
