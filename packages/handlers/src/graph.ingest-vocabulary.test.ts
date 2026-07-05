import { afterEach, describe, expect, it, vi } from "vitest";

// ── Mock the two data sources the resolver reaches ──────────────────────────
const sessionRun = vi.fn();
const sessionClose = vi.fn();
vi.mock("@oxagen/ontology/tenant", () => ({
  scopedSession: () => ({ run: sessionRun, close: sessionClose }),
}));

vi.mock("@oxagen/tenancy", () => ({
  // Run the callback synchronously — scope plumbing is not under test here.
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));

const txExecute = vi.fn();
vi.mock("@oxagen/database", () => ({
  withTenantDb: (fn: (tx: { execute: typeof txExecute }) => unknown) => fn({ execute: txExecute }),
}));

vi.mock("./logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import type { CapabilityContext } from "@oxagen/oxagen";
import {
  resolveIngestVocabulary,
  renderVocabularyPrompt,
  strictAllowedLabels,
  type IngestVocabulary,
} from "./graph.ingest-vocabulary";

const ctx: CapabilityContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "u",
  apiKeyId: null,
  requestId: "req-1",
  surface: "runner",
  messageId: null,
};

/** Build a Neo4j-style record from a flat object. */
function rec(fields: Record<string, unknown>) {
  return { get: (k: string) => fields[k] };
}

afterEach(() => {
  sessionRun.mockReset();
  sessionClose.mockReset();
  txExecute.mockReset();
});

describe("resolveIngestVocabulary", () => {
  it("returns source=graph from existing labels when no registry is pinned", async () => {
    sessionRun.mockResolvedValue({
      records: [
        rec({ label: "Submarine", c: 2, samples: ['{"hull_number":"SSN-571","confidence":0.9}'] }),
        rec({ label: "Person", c: 3, samples: ['{"rank":"Admiral"}'] }),
      ],
    });
    txExecute.mockResolvedValue([]); // no registries row → registry path returns null

    const vocab = await resolveIngestVocabulary(ctx);
    expect(vocab.source).toBe("graph");
    expect(vocab.enforcement).toBe("off");
    expect(vocab.labels.map((l) => l.name).sort()).toEqual(["Person", "Submarine"]);
    const sub = vocab.labels.find((l) => l.name === "Submarine");
    // confidence is stripped from observed keys; hull_number kept.
    expect(sub?.observedPropertyKeys).toEqual(["hull_number"]);
    expect(sub?.existingCount).toBe(2);
  });

  it("returns source=none when the graph is empty and no registry", async () => {
    sessionRun.mockResolvedValue({ records: [] });
    txExecute.mockResolvedValue([]);
    const vocab = await resolveIngestVocabulary(ctx);
    expect(vocab.source).toBe("none");
    expect(vocab.labels).toHaveLength(0);
  });

  // OXA-2062: the readGraphLabels() query referenced $orgId/$workspaceId but
  // was previously invoked with NO params object at all, relying entirely on
  // scopedSession()'s auto-injection. A mocked scopedSession (as used here)
  // does NOT auto-inject, so this bug was invisible to this suite until
  // orgId/workspaceId were bound explicitly.
  it("binds orgId and workspaceId explicitly in the graph-labels query params (regression: previously relied solely on scopedSession auto-injection)", async () => {
    sessionRun.mockResolvedValue({ records: [] });
    txExecute.mockResolvedValue([]);
    await resolveIngestVocabulary(ctx);
    const params = sessionRun.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params).toBeDefined();
    expect(params.orgId).toBe(ctx.orgId);
    expect(params.workspaceId).toBe(ctx.workspaceId);
  });

  it("makes the pinned+enabled registry authoritative and enriches it with observed keys", async () => {
    sessionRun.mockResolvedValue({
      records: [rec({ label: "Submarine", c: 5, samples: ['{"hull_number":"SSN-571"}'] })],
    });
    // tx.execute sequence: registries, node_labels, properties, relationship_types
    txExecute
      .mockResolvedValueOnce([{ pinned_version_id: "v1", enforcement_mode: "strict" }])
      .mockResolvedValueOnce([
        { id: "lbl-1", name: "Submarine", display_name: "Submarine", description: "A sub" },
      ])
      .mockResolvedValueOnce([
        {
          label_name: "Submarine",
          key: "hull_number",
          data_type: "string",
          required: true,
          description: null,
          enum_values: null,
          example: "SSN-571",
        },
      ])
      .mockResolvedValueOnce([
        { name: "BUILT_BY", start_label: "Submarine", end_label: "Organization", description: null },
      ]);

    const vocab = await resolveIngestVocabulary(ctx);
    expect(vocab.source).toBe("registry");
    expect(vocab.enforcement).toBe("strict");
    expect(vocab.labels).toHaveLength(1);
    const sub = vocab.labels[0];
    expect(sub?.name).toBe("Submarine");
    expect(sub?.properties.map((p) => p.key)).toEqual(["hull_number"]);
    expect(sub?.properties[0]?.required).toBe(true);
    // observed keys folded in from the live graph
    expect(sub?.observedPropertyKeys).toEqual(["hull_number"]);
    expect(sub?.existingCount).toBe(5);
    expect(vocab.edges.map((e) => e.name)).toEqual(["BUILT_BY"]);
  });

  it("under lenient registry, also surfaces graph-only labels not in the registry", async () => {
    sessionRun.mockResolvedValue({
      records: [
        rec({ label: "Submarine", c: 1, samples: ["{}"] }),
        rec({ label: "Legacy", c: 4, samples: ["{}"] }),
      ],
    });
    txExecute
      .mockResolvedValueOnce([{ pinned_version_id: "v1", enforcement_mode: "lenient" }])
      .mockResolvedValueOnce([{ id: "lbl-1", name: "Submarine", display_name: null, description: null }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const vocab = await resolveIngestVocabulary(ctx);
    expect(vocab.source).toBe("registry");
    expect(vocab.labels.map((l) => l.name).sort()).toEqual(["Legacy", "Submarine"]);
  });

  it("degrades to graph vocabulary when the registry read throws", async () => {
    sessionRun.mockResolvedValue({
      records: [rec({ label: "Submarine", c: 1, samples: ["{}"] })],
    });
    txExecute.mockRejectedValue(new Error("schema_registry relation missing"));
    const vocab = await resolveIngestVocabulary(ctx);
    expect(vocab.source).toBe("graph");
    expect(vocab.labels.map((l) => l.name)).toEqual(["Submarine"]);
  });
});

describe("renderVocabularyPrompt", () => {
  it("is empty when there are no labels", () => {
    const vocab: IngestVocabulary = { source: "none", enforcement: "off", labels: [], edges: [] };
    expect(renderVocabularyPrompt(vocab)).toBe("");
  });

  it("lists labels, typed properties, edges, and the strict directive", () => {
    const vocab: IngestVocabulary = {
      source: "registry",
      enforcement: "strict",
      labels: [
        {
          name: "Submarine",
          properties: [{ key: "hull_number", dataType: "string", required: true }],
          observedPropertyKeys: ["voyage_year"],
          existingCount: 2,
        },
      ],
      edges: [{ name: "BUILT_BY", startLabel: "Submarine", endLabel: "Organization" }],
    };
    const out = renderVocabularyPrompt(vocab);
    expect(out).toContain("Submarine");
    expect(out).toContain("hull_number:string*");
    expect(out).toContain("voyage_year"); // observed key folded in
    expect(out).toContain("BUILT_BY (Submarine→Organization)");
    expect(out).toContain("ENFORCEMENT=strict");
  });
});

describe("strictAllowedLabels", () => {
  it("returns null unless registry + strict", () => {
    expect(
      strictAllowedLabels({ source: "graph", enforcement: "strict", labels: [], edges: [] }),
    ).toBeNull();
    expect(
      strictAllowedLabels({ source: "registry", enforcement: "lenient", labels: [], edges: [] }),
    ).toBeNull();
  });

  it("returns the lowercased label set for registry+strict", () => {
    const set = strictAllowedLabels({
      source: "registry",
      enforcement: "strict",
      labels: [
        { name: "Submarine", properties: [], observedPropertyKeys: [], existingCount: 0 },
        { name: "Person", properties: [], observedPropertyKeys: [], existingCount: 0 },
      ],
      edges: [],
    });
    expect(set).toEqual(new Set(["submarine", "person"]));
  });
});
