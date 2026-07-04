import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerCapability } from "./registry";
import {
  CAPABILITY_DATA_TAGS,
  CURATED_CHAIN_META,
  CURATED_RENDER_HINTS,
  RECORD_LINK_ROUTES,
  getCapabilityChain,
  getRenderHint,
  inferRecordTypeForField,
  readOutputPath,
  resolveRecordHref,
  resolveRecordLinks,
  resolveRenderDirective,
  shouldSynthesizeComponent,
} from "./capability-meta";

const SLUGS = { orgSlug: "acme", workspaceSlug: "research" };

describe("readOutputPath", () => {
  it("reads a top-level field", () => {
    expect(readOutputPath({ a: 1 }, "a")).toBe(1);
  });
  it("reads a nested dot-path", () => {
    expect(readOutputPath({ node: { displayName: "USS Nautilus" } }, "node.displayName")).toBe(
      "USS Nautilus",
    );
  });
  it("returns undefined for a missing path or a non-object hop", () => {
    expect(readOutputPath({ node: null }, "node.displayName")).toBeUndefined();
    expect(readOutputPath({ a: 5 }, "a.b")).toBeUndefined();
    expect(readOutputPath(null, "a")).toBeUndefined();
    expect(readOutputPath({ a: 1 }, "")).toBeUndefined();
  });
});

describe("inferRecordTypeForField", () => {
  it("maps node id fields to graph.node (case-insensitive)", () => {
    expect(inferRecordTypeForField("nodeId")).toBe("graph.node");
    expect(inferRecordTypeForField("fromNodeId")).toBe("graph.node");
    expect(inferRecordTypeForField("toNodeId")).toBe("graph.node");
  });
  it("maps conversation + explicit asset id fields", () => {
    expect(inferRecordTypeForField("conversationId")).toBe("conversation");
    expect(inferRecordTypeForField("assetId")).toBe("asset");
    expect(inferRecordTypeForField("asset_id")).toBe("asset");
  });
  // Regression — a bare `publicId` is a UNIVERSAL id field (agents `agt_…`,
  // conversations `cnv_…`, mcp servers …), not asset-specific. Inferring `asset`
  // from the field name alone built a dead `/api/v1/assets/agt_…` deep-link for
  // agent.definition.* outputs that surfaced raw API JSON to the chat surface.
  describe("publicId is asset-typed only for a generated-asset (`gen_`) value", () => {
    it("maps a gen_-prefixed publicId to asset", () => {
      expect(inferRecordTypeForField("publicId", "gen_abc123")).toBe("asset");
    });
    it("does NOT map an agent publicId (agt_…) to asset", () => {
      expect(inferRecordTypeForField("publicId", "agt_ccbpt7mffmqwbtbg1z1sfg")).toBeNull();
    });
    it("does NOT map a conversation publicId (cnv_…) or any other prefix to asset", () => {
      expect(inferRecordTypeForField("publicId", "cnv_xyz")).toBeNull();
      expect(inferRecordTypeForField("publicId", "wrk_xyz")).toBeNull();
    });
    it("does NOT map a publicId to asset when no value is provided", () => {
      expect(inferRecordTypeForField("publicId")).toBeNull();
    });
  });
  it("returns null for unrecognized fields", () => {
    expect(inferRecordTypeForField("created")).toBeNull();
    expect(inferRecordTypeForField("status")).toBeNull();
  });
});

describe("resolveRecordHref", () => {
  it("builds a tenant-scoped graph.node href", () => {
    expect(resolveRecordHref("graph.node", "n_123", SLUGS)).toBe(
      "/acme/research/knowledge/nodes/n_123",
    );
  });
  it("builds a conversation href", () => {
    expect(resolveRecordHref("conversation", "c_9", SLUGS)).toBe("/acme/research/chat/c_9");
  });
  it("builds an asset href WITHOUT requiring slugs", () => {
    expect(resolveRecordHref("asset", "gen_1", {})).toBe("/api/v1/assets/gen_1");
  });
  it("returns null when a slug-requiring route is missing slugs", () => {
    expect(resolveRecordHref("graph.node", "n_1", {})).toBeNull();
    expect(resolveRecordHref("graph.node", "n_1", { orgSlug: "acme" })).toBeNull();
  });
  it("returns null for an unknown record type or empty id", () => {
    expect(resolveRecordHref("nope", "x", SLUGS)).toBeNull();
    expect(resolveRecordHref("asset", "", {})).toBeNull();
  });
  it("url-encodes ids and slugs", () => {
    expect(resolveRecordHref("asset", "a b/c", {})).toBe("/api/v1/assets/a%20b%2Fc");
  });
});

describe("resolveRecordLinks", () => {
  it("resolves explicit specs by dot-path with a label", () => {
    const out = { node: { nodeId: "n_1", displayName: "Reactor" } };
    const links = resolveRecordLinks(
      out,
      [{ field: "node.nodeId", recordType: "graph.node", labelField: "node.displayName" }],
      SLUGS,
    );
    expect(links).toEqual([
      {
        field: "node.nodeId",
        recordType: "graph.node",
        id: "n_1",
        href: "/acme/research/knowledge/nodes/n_1",
        label: "Reactor",
      },
    ]);
  });
  it("falls back to the id as label when labelField is absent/empty", () => {
    const links = resolveRecordLinks(
      { nodeId: "n_2" },
      [{ field: "nodeId", recordType: "graph.node" }],
      SLUGS,
    );
    expect(links[0]?.label).toBe("n_2");
  });
  it("skips specs whose field is missing or non-string", () => {
    const links = resolveRecordLinks(
      { nodeId: 42 },
      [{ field: "nodeId", recordType: "graph.node" }],
      SLUGS,
    );
    expect(links).toEqual([]);
  });
  it("heuristically scans top-level string fields when no specs given", () => {
    const links = resolveRecordLinks(
      { nodeId: "n_9", created: true, label: "Person" },
      undefined,
      SLUGS,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ recordType: "graph.node", id: "n_9" });
  });
  it("returns [] for non-object output", () => {
    expect(resolveRecordLinks("hi", undefined, SLUGS)).toEqual([]);
    expect(resolveRecordLinks(null, undefined, SLUGS)).toEqual([]);
  });
  // Regression: agent.definition.get returns a top-level `publicId: "agt_…"`.
  // It must NOT be turned into an `/api/v1/assets/agt_…` deep-link (the prod
  // 404 that surfaced the API's "Organization not found" JSON in chat).
  it("does NOT build an asset link from an agent publicId (agt_…)", () => {
    const agentOutput = {
      publicId: "agt_ccbpt7mffmqwbtbg1z1sfg",
      slug: "my-agent",
      name: "My Agent",
      status: "active",
    };
    const links = resolveRecordLinks(agentOutput, undefined, SLUGS);
    expect(links).toEqual([]);
  });
  // The legitimate generated-asset case (publicId is a `gen_…` id) still links.
  it("still builds an asset link from a generated-asset publicId (gen_…)", () => {
    const links = resolveRecordLinks({ publicId: "gen_abc" }, undefined, SLUGS);
    expect(links).toEqual([
      {
        field: "publicId",
        recordType: "asset",
        id: "gen_abc",
        href: "/api/v1/assets/gen_abc",
        label: "gen_abc",
      },
    ]);
  });
});

describe("getRenderHint / curated tables", () => {
  it("returns a curated hint for a prioritized capability", () => {
    expect(getRenderHint("web.search")).toEqual({ componentId: "web-search-card" });
    expect(getRenderHint("graph.node.get")?.componentId).toBe("graph-node-card");
  });
  it("returns undefined for an uncurated capability with no declared render", () => {
    expect(getRenderHint("totally.unknown.capability")).toBeUndefined();
  });
  it("prefers a contract-declared render hint over the curated table", () => {
    registerCapability({
      name: "test.meta.declared-render",
      domain: "test",
      description: "fixture",
      mode: "sync",
      layers: ["schema"],
      sensitivity: "low",
      defaultEffect: "allow",
      defaultRoles: { org: {}, workspace: {} },
      input: z.object({}),
      output: z.object({ x: z.string() }),
      render: { componentId: "declared-card" },
      produces: ["graph.nodeId"],
      consumes: ["topic"],
      chainHints: ["graph.edge.upsert"],
    });
    expect(getRenderHint("test.meta.declared-render")).toEqual({ componentId: "declared-card" });
  });
  it("every curated render-hint componentId is a non-empty string", () => {
    for (const hint of Object.values(CURATED_RENDER_HINTS)) {
      expect(hint.componentId.length).toBeGreaterThan(0);
    }
  });
});

describe("getCapabilityChain", () => {
  it("returns curated chain metadata", () => {
    const chain = getCapabilityChain("web.search");
    expect(chain.produces).toContain("search.results");
    expect(chain.chainHints).toContain("graph.node.upsert");
  });
  it("returns an empty chain for an uncurated capability", () => {
    expect(getCapabilityChain("totally.unknown.capability")).toEqual({
      produces: [],
      consumes: [],
      chainHints: [],
    });
  });
  it("prefers contract-declared chain metadata", () => {
    // Registered by the getRenderHint test above; registry is a process singleton.
    const chain = getCapabilityChain("test.meta.declared-render");
    expect(chain.produces).toEqual(["graph.nodeId"]);
    expect(chain.consumes).toEqual(["topic"]);
    expect(chain.chainHints).toEqual(["graph.edge.upsert"]);
  });
  it("all curated produces/consumes tags are in the controlled vocabulary", () => {
    const vocab = new Set<string>(CAPABILITY_DATA_TAGS);
    for (const meta of Object.values(CURATED_CHAIN_META)) {
      for (const tag of [...(meta.produces ?? []), ...(meta.consumes ?? [])]) {
        expect(vocab.has(tag)).toBe(true);
      }
    }
  });
  it("every chainHints target is itself a known curated capability or render hint", () => {
    // Soft integrity: hints should point at capabilities we know how to present.
    const known = new Set<string>([
      ...Object.keys(CURATED_CHAIN_META),
      ...Object.keys(CURATED_RENDER_HINTS),
    ]);
    for (const meta of Object.values(CURATED_CHAIN_META)) {
      for (const hint of meta.chainHints ?? []) {
        expect(known.has(hint)).toBe(true);
      }
    }
  });
});

describe("shouldSynthesizeComponent", () => {
  it("renders when there are record links", () => {
    expect(
      shouldSynthesizeComponent({ created: true }, [
        { field: "nodeId", recordType: "graph.node", id: "n", href: null, label: "n" },
      ]),
    ).toBe(true);
  });
  it("skips a lone boolean ack", () => {
    expect(shouldSynthesizeComponent({ created: true }, [])).toBe(false);
  });
  it("renders a single nested object/array field", () => {
    expect(shouldSynthesizeComponent({ node: { nodeId: "n" } }, [])).toBe(true);
    expect(shouldSynthesizeComponent({ results: [1, 2] }, [])).toBe(true);
  });
  it("renders multi-field outputs", () => {
    expect(shouldSynthesizeComponent({ a: 1, b: 2 }, [])).toBe(true);
  });
  it("ignores the embedded render key when counting fields", () => {
    expect(shouldSynthesizeComponent({ render: { componentId: "x" } }, [])).toBe(false);
  });
  it("skips empty / non-object / empty-array outputs", () => {
    expect(shouldSynthesizeComponent({}, [])).toBe(false);
    expect(shouldSynthesizeComponent(null, [])).toBe(false);
    expect(shouldSynthesizeComponent("str", [])).toBe(false);
    expect(shouldSynthesizeComponent([], [])).toBe(false);
  });
});

describe("resolveRenderDirective", () => {
  it("routes a curated capability to its bespoke component with the envelope", () => {
    const output = { results: [{ title: "USS Nautilus", url: "https://x", content: "…", score: 1 }], totalResults: 1, searchId: "s_1" };
    const d = resolveRenderDirective({ capability: "web.search", output, slugs: SLUGS });
    expect(d).not.toBeNull();
    expect(d?.componentId).toBe("web-search-card");
    expect(d?.props).toMatchObject({ capability: "web.search", output, orgSlug: "acme", workspaceSlug: "research" });
    expect(Array.isArray(d?.props.links)).toBe(true);
  });

  it("resolves record links + title for graph.node.get", () => {
    const output = { node: { nodeId: "n_7", displayName: "Hyman Rickover", label: "Person" } };
    const d = resolveRenderDirective({ capability: "graph.node.get", output, slugs: SLUGS });
    expect(d?.componentId).toBe("graph-node-card");
    expect(d?.props.title).toBe("Hyman Rickover");
    const links = d?.props.links as Array<{ href: string | null; id: string }>;
    expect(links[0]).toMatchObject({ id: "n_7", href: "/acme/research/knowledge/nodes/n_7" });
  });

  it("falls back to the generic capability-result component for an uncurated, substantial output", () => {
    const output = { wordCount: 1200, title: "Page", content: "lots of text", statusCode: 200, url: "https://x", fetchedAt: "t" };
    const d = resolveRenderDirective({ capability: "web.fetch", output, slugs: SLUGS });
    expect(d?.componentId).toBe("capability-result");
    expect(d?.props.capability).toBe("web.fetch");
  });

  it("returns null for a trivial uncurated ack (stays on the compact card)", () => {
    expect(resolveRenderDirective({ capability: "some.ack", output: { ok: true }, slugs: SLUGS })).toBeNull();
  });

  it("omits slug props and yields href:null links when slugs are absent", () => {
    const output = { nodeId: "n_1", created: true };
    const d = resolveRenderDirective({ capability: "graph.node.upsert", output });
    expect(d?.props.orgSlug).toBeUndefined();
    const links = d?.props.links as Array<{ href: string | null }>;
    expect(links[0]?.href).toBeNull();
  });

  // ── Coding-agent artifact renderers ─────────────────────────────────────────

  describe("agent.repo.edit → code-diff", () => {
    it("maps changedFiles to code-diff-card file entries with empty patches", () => {
      const output = {
        prNumber: 42,
        prUrl: "https://github.com/acme/widgets/pull/42",
        branch: "agent/fix-bug",
        changedFiles: ["src/index.ts", "src/util.ts"],
        summary: "Fixed the bug.",
      };
      const d = resolveRenderDirective({ capability: "agent.repo.edit", output, slugs: SLUGS });
      expect(d?.componentId).toBe("code-diff");
      expect(d?.props.files).toEqual([
        { path: "src/index.ts", patch: "", additions: 0, deletions: 0 },
        { path: "src/util.ts", patch: "", additions: 0, deletions: 0 },
      ]);
    });

    it("returns an empty files array when changedFiles is missing", () => {
      const d = resolveRenderDirective({
        capability: "agent.repo.edit",
        output: { prNumber: 1, prUrl: "x", branch: "b", summary: "s" },
      });
      expect(d?.componentId).toBe("code-diff");
      expect(d?.props.files).toEqual([]);
    });
  });

  describe("repo.file.put → code-diff", () => {
    it("recovers the file path from the GitHub blob URL", () => {
      const output = {
        commitSha: "abc123",
        htmlUrl: "https://github.com/acme/widgets/blob/main/src/index.ts",
      };
      const d = resolveRenderDirective({ capability: "repo.file.put", output });
      expect(d?.componentId).toBe("code-diff");
      expect(d?.props.files).toEqual([
        { path: "src/index.ts", patch: "", additions: 0, deletions: 0 },
      ]);
    });

    it("yields an empty files array when the htmlUrl doesn't match the expected shape", () => {
      const output = { commitSha: "abc123", htmlUrl: "https://example.com/not-github" };
      const d = resolveRenderDirective({ capability: "repo.file.put", output });
      expect(d?.props.files).toEqual([]);
    });
  });

  describe("agent.sandbox.exec → terminal-trace (large output only)", () => {
    it("stays on the generic capability-result card for small output", () => {
      const output = {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        executionMs: 120,
        timedOut: false,
        restored: false,
      };
      const d = resolveRenderDirective({ capability: "agent.sandbox.exec", output });
      expect(d?.componentId).toBe("capability-result");
    });

    it("routes to terminal-trace once stdout+stderr exceeds the large-output threshold", () => {
      const output = {
        exitCode: 0,
        stdout: "x".repeat(3000),
        stderr: "",
        executionMs: 4200,
        timedOut: false,
        restored: false,
      };
      const d = resolveRenderDirective({ capability: "agent.sandbox.exec", output });
      expect(d?.componentId).toBe("terminal-trace");
      expect(d?.props).toEqual({
        stdout: "x".repeat(3000),
        stderr: "",
        exitCode: 0,
        durationMs: 4200,
      });
    });

    it("counts combined stdout+stderr length toward the large-output threshold", () => {
      const output = {
        exitCode: 1,
        stdout: "x".repeat(1200),
        stderr: "y".repeat(1200),
        executionMs: 500,
        timedOut: false,
        restored: false,
      };
      const d = resolveRenderDirective({ capability: "agent.sandbox.exec", output });
      expect(d?.componentId).toBe("terminal-trace");
    });
  });
});

describe("route + vocabulary integrity", () => {
  it("RECORD_LINK_ROUTES templates all contain an {id} placeholder", () => {
    for (const tmpl of Object.values(RECORD_LINK_ROUTES)) {
      expect(tmpl.includes("{id}")).toBe(true);
    }
  });
  it("every recordLink recordType used in curated hints has a known route OR is intentionally route-less", () => {
    // graph.node + conversation + asset are the routed types; assert curated
    // specs only reference recordTypes we recognise.
    const recognised = new Set<string>([...Object.keys(RECORD_LINK_ROUTES), "graph.edge"]);
    for (const hint of Object.values(CURATED_RENDER_HINTS)) {
      for (const spec of hint.recordLinks ?? []) {
        expect(recognised.has(spec.recordType)).toBe(true);
      }
    }
  });
});
