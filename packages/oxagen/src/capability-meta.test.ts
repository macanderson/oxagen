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
    expect(
      readOutputPath(
        { node: { displayName: "USS Nautilus" } },
        "node.displayName",
      ),
    ).toBe("USS Nautilus");
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
      expect(
        inferRecordTypeForField("publicId", "agt_ccbpt7mffmqwbtbg1z1sfg"),
      ).toBeNull();
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
      "/acme/research/knowledge/graph/n_123",
    );
  });
  it("builds a conversation href", () => {
    expect(resolveRecordHref("conversation", "c_9", SLUGS)).toBe(
      "/acme/research/chat/c_9",
    );
    expect(resolveRecordHref("agent", "agt_1", SLUGS)).toBe(
      "/acme/research/workbench/agents/agt_1",
    );
  });
  it("builds an asset href WITHOUT requiring slugs", () => {
    expect(resolveRecordHref("asset", "gen_1", {})).toBe(
      "/api/v1/assets/gen_1",
    );
  });
  it("returns null when a slug-requiring route is missing slugs", () => {
    expect(resolveRecordHref("graph.node", "n_1", {})).toBeNull();
    expect(
      resolveRecordHref("graph.node", "n_1", { orgSlug: "acme" }),
    ).toBeNull();
  });
  it("returns null for an unknown record type or empty id", () => {
    expect(resolveRecordHref("nope", "x", SLUGS)).toBeNull();
    expect(resolveRecordHref("asset", "", {})).toBeNull();
  });
  it("url-encodes ids and slugs", () => {
    expect(resolveRecordHref("asset", "a b/c", {})).toBe(
      "/api/v1/assets/a%20b%2Fc",
    );
  });
});

describe("resolveRecordLinks", () => {
  it("resolves explicit specs by dot-path with a label", () => {
    const out = { node: { nodeId: "n_1", displayName: "Reactor" } };
    const links = resolveRecordLinks(
      out,
      [
        {
          field: "node.nodeId",
          recordType: "graph.node",
          labelField: "node.displayName",
        },
      ],
      SLUGS,
    );
    expect(links).toEqual([
      {
        field: "node.nodeId",
        recordType: "graph.node",
        id: "n_1",
        href: "/acme/research/knowledge/graph/n_1",
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
    expect(getRenderHint("search_web")).toEqual({
      componentId: "web-search-card",
    });
    expect(getRenderHint("get_node")?.componentId).toBe("graph-node-card");
    expect(getRenderHint("list_agent_defs")).toEqual({
      componentId: "agent-definition-list-card",
    });
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
      chainHints: ["generate_document"],
    });
    expect(getRenderHint("test.meta.declared-render")).toEqual({
      componentId: "declared-card",
    });
  });
  it("every curated render-hint componentId is a non-empty string", () => {
    for (const hint of Object.values(CURATED_RENDER_HINTS)) {
      expect(hint.componentId.length).toBeGreaterThan(0);
    }
  });
});

describe("getCapabilityChain", () => {
  it("returns curated chain metadata", () => {
    const chain = getCapabilityChain("search_web");
    expect(chain.produces).toContain("search.results");
    expect(chain.chainHints).toContain("generate_document");
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
    expect(chain.chainHints).toEqual(["generate_document"]);
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
        {
          field: "nodeId",
          recordType: "graph.node",
          id: "n",
          href: null,
          label: "n",
        },
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
    expect(
      shouldSynthesizeComponent({ render: { componentId: "x" } }, []),
    ).toBe(false);
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
    const output = {
      results: [
        { title: "USS Nautilus", url: "https://x", content: "…", score: 1 },
      ],
      totalResults: 1,
      searchId: "s_1",
    };
    const d = resolveRenderDirective({
      capability: "search_web",
      output,
      slugs: SLUGS,
    });
    expect(d).not.toBeNull();
    expect(d?.componentId).toBe("web-search-card");
    expect(d?.props).toMatchObject({
      capability: "search_web",
      output,
      orgSlug: "acme",
      workspaceSlug: "research",
    });
    expect(Array.isArray(d?.props.links)).toBe(true);
  });

  it("resolves record links + title for graph.node.get", () => {
    const output = {
      node: { nodeId: "n_7", displayName: "Hyman Rickover", label: "Person" },
    };
    const d = resolveRenderDirective({
      capability: "get_node",
      output,
      slugs: SLUGS,
    });
    expect(d?.componentId).toBe("graph-node-card");
    expect(d?.props.title).toBe("Hyman Rickover");
    const links = d?.props.links as Array<{ href: string | null; id: string }>;
    expect(links[0]).toMatchObject({
      id: "n_7",
      href: "/acme/research/knowledge/graph/n_7",
    });
  });

  it("falls back to the generic capability-result component for an uncurated, substantial output", () => {
    const output = {
      wordCount: 1200,
      title: "Page",
      content: "lots of text",
      statusCode: 200,
      url: "https://x",
      fetchedAt: "t",
    };
    const d = resolveRenderDirective({
      capability: "fetch_web_page",
      output,
      slugs: SLUGS,
    });
    expect(d?.componentId).toBe("capability-result");
    expect(d?.props.capability).toBe("fetch_web_page");
  });

  it("returns null for a trivial uncurated ack (stays on the compact card)", () => {
    expect(
      resolveRenderDirective({
        capability: "some.ack",
        output: { ok: true },
        slugs: SLUGS,
      }),
    ).toBeNull();
  });
});

describe("resolveRenderDirective — structural transforms (coding-agent cards)", () => {
  it("maps agent.repo.edit's changedFiles to a code-diff card with no patch content", () => {
    const output = {
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      branch: "agent/fix-health",
      changedFiles: ["src/index.ts", "src/routes/health.ts"],
      summary: "Wired up the health-check route.",
    };
    const d = resolveRenderDirective({ capability: "edit_repo_file", output });
    expect(d?.componentId).toBe("code-diff");
    expect(d?.props.files).toEqual([
      { path: "src/index.ts", patch: null, additions: null, deletions: null },
      {
        path: "src/routes/health.ts",
        patch: null,
        additions: null,
        deletions: null,
      },
    ]);
    expect(d?.props.summary).toBe("Wired up the health-check route.");
    expect(d?.props.externalUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(d?.props.externalLabel).toBe("PR #42");
  });

  it("maps agent.repo.edit's diffs onto matching changedFiles entries with real patch text", () => {
    const output = {
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      branch: "agent/fix-health",
      changedFiles: ["src/index.ts", "src/routes/health.ts"],
      summary: "Wired up the health-check route.",
      diffs: [
        {
          path: "src/index.ts",
          patch:
            "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n line 1\n+line 2\n",
          additions: 1,
          deletions: 0,
        },
        // src/routes/health.ts intentionally has no matching diffs entry —
        // e.g. the sandbox's combined diff didn't include it — so it should
        // fall back to the path-only row without breaking the other file.
      ],
    };
    const d = resolveRenderDirective({ capability: "edit_repo_file", output });
    expect(d?.componentId).toBe("code-diff");
    expect(d?.props.files).toEqual([
      {
        path: "src/index.ts",
        patch: output.diffs[0]?.patch,
        additions: 1,
        deletions: 0,
      },
      {
        path: "src/routes/health.ts",
        patch: null,
        additions: null,
        deletions: null,
      },
    ]);
  });

  it("returns null for agent.repo.edit when changedFiles is empty (falls through to standard path)", () => {
    const d = resolveRenderDirective({
      capability: "edit_repo_file",
      output: {
        prNumber: 1,
        prUrl: "x",
        branch: "b",
        changedFiles: [],
        summary: "s",
      },
    });
    // No changed files and no curated hint for agent.repo.edit — a substantial
    // object still synthesizes the generic fallback, never "code-diff".
    expect(d?.componentId).not.toBe("code-diff");
  });

  it("maps repo.file.put's commit output to a code-diff card, deriving the path from htmlUrl", () => {
    const output = {
      commitSha: "a1b2c3d4e5f6",
      htmlUrl: "https://github.com/acme/repo/blob/main/src%2Fconfig.ts",
    };
    const d = resolveRenderDirective({ capability: "put_repo_file", output });
    expect(d?.componentId).toBe("code-diff");
    expect(d?.props.files).toEqual([
      { path: "src/config.ts", patch: null, additions: null, deletions: null },
    ]);
    expect(d?.props.externalUrl).toBe(output.htmlUrl);
    expect(d?.props.externalLabel).toBe("commit a1b2c3d");
  });

  it("maps repo.file.put's diffs onto the code-diff card, preferring the diff's own path", () => {
    const output = {
      commitSha: "a1b2c3d4e5f6",
      htmlUrl: "https://github.com/acme/repo/blob/main/src%2Fconfig.ts",
      diffs: [
        {
          path: "src/config.ts",
          patch:
            "--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1 +1 @@\n-old\n+new\n",
          additions: 1,
          deletions: 1,
        },
      ],
    };
    const d = resolveRenderDirective({ capability: "put_repo_file", output });
    expect(d?.componentId).toBe("code-diff");
    expect(d?.props.files).toEqual([
      {
        path: "src/config.ts",
        patch: output.diffs[0]?.patch,
        additions: 1,
        deletions: 1,
      },
    ]);
    expect(d?.props.externalUrl).toBe(output.htmlUrl);
    expect(d?.props.externalLabel).toBe("commit a1b2c3d");
  });

  it("falls back to a generic 'file' path for repo.file.put when htmlUrl has no /blob/ segment", () => {
    const d = resolveRenderDirective({
      capability: "put_repo_file",
      output: { commitSha: "abc1234", htmlUrl: "https://example.com/opaque" },
    });
    expect((d?.props.files as Array<{ path: string }>)[0]?.path).toBe("opaque");
  });

  it("maps large agent.sandbox.exec output to terminal-trace", () => {
    const stdout = Array.from({ length: 45 }, (_, i) => `line ${i}`).join("\n");
    const d = resolveRenderDirective({
      capability: "run_sandbox_command",
      output: {
        exitCode: 0,
        stdout,
        stderr: "",
        executionMs: 500,
        timedOut: false,
        restored: false,
      },
    });
    expect(d?.componentId).toBe("terminal-trace");
    expect(d?.props).toMatchObject({
      exitCode: 0,
      durationMs: 500,
      timedOut: false,
    });
  });

  it("does NOT map small agent.sandbox.exec output to terminal-trace", () => {
    const d = resolveRenderDirective({
      capability: "run_sandbox_command",
      output: {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        executionMs: 100,
        timedOut: false,
        restored: false,
      },
    });
    expect(d?.componentId).not.toBe("terminal-trace");
  });

  it("combines stdout+stderr line counts against the threshold", () => {
    const stdout = Array.from({ length: 20 }, (_, i) => `out ${i}`).join("\n");
    const stderr = Array.from({ length: 25 }, (_, i) => `err ${i}`).join("\n");
    const d = resolveRenderDirective({
      capability: "run_sandbox_command",
      output: {
        exitCode: 1,
        stdout,
        stderr,
        executionMs: 200,
        timedOut: false,
        restored: false,
      },
    });
    expect(d?.componentId).toBe("terminal-trace");
  });

  // repo.pr.get → pr-stats — the transform is a guarded pass-through: the PR
  // output IS the card's props, gated on a numeric `number` field.
  it("passes repo.pr.get output through to the pr-stats card verbatim", () => {
    const output = {
      number: 42,
      title: "Wire up the health route",
      state: "open",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      url: "https://github.com/acme/repo/pull/42",
    };
    const d = resolveRenderDirective({ capability: "get_pr", output });
    expect(d?.componentId).toBe("pr-stats");
    expect(d?.props).toBe(output);
  });

  it("returns null for repo.pr.get output missing a numeric `number` (falls through)", () => {
    // No `number` field → not a PR-stats shape → transform yields null and the
    // standard path renders the generic card, never pr-stats.
    const d = resolveRenderDirective({
      capability: "get_pr",
      output: { title: "no number here", state: "open" },
    });
    expect(d?.componentId).not.toBe("pr-stats");
  });

  // repo.ci.status → ci-status — pass-through gated on a `runs` array.
  it("passes repo.ci.status output through to the ci-status card verbatim", () => {
    const output = {
      state: "success",
      runs: [
        {
          name: "build",
          status: "completed",
          conclusion: "success",
          url: "https://x/1",
        },
        {
          name: "test",
          status: "completed",
          conclusion: "success",
          url: "https://x/2",
        },
      ],
    };
    const d = resolveRenderDirective({ capability: "get_ci_status", output });
    expect(d?.componentId).toBe("ci-status");
    expect(d?.props).toBe(output);
  });

  it("returns null for repo.ci.status output whose `runs` is not an array", () => {
    const d = resolveRenderDirective({
      capability: "get_ci_status",
      output: { state: "pending", runs: null },
    });
    expect(d?.componentId).not.toBe("ci-status");
  });

  // repo.pr.diff → code-diff — maps the PR file list onto the card's flat
  // {path, patch, additions, deletions} shape.
  it("maps repo.pr.diff files onto a code-diff card", () => {
    const output = {
      summary: "2 files changed",
      files: [
        {
          path: "src/index.ts",
          patch:
            "--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1,2 @@\n a\n+b\n",
          additions: 1,
          deletions: 0,
        },
        // A file missing patch/stats coerces to null fields, not undefined.
        { path: "README.md" },
      ],
    };
    const d = resolveRenderDirective({ capability: "get_pr_diff", output });
    expect(d?.componentId).toBe("code-diff");
    expect(d?.props.files).toEqual([
      {
        path: "src/index.ts",
        patch: output.files[0]!.patch,
        additions: 1,
        deletions: 0,
      },
      { path: "README.md", patch: null, additions: null, deletions: null },
    ]);
    expect(d?.props.summary).toBe("2 files changed");
  });

  it("defaults a repo.pr.diff file's path to 'file' when absent", () => {
    const d = resolveRenderDirective({
      capability: "get_pr_diff",
      output: { files: [{ patch: "@@ -0 +1 @@\n+x\n" }] },
    });
    expect((d?.props.files as Array<{ path: string }>)[0]?.path).toBe("file");
  });

  it("returns null for repo.pr.diff with an empty or non-array file list (falls through)", () => {
    expect(
      resolveRenderDirective({
        capability: "get_pr_diff",
        output: { files: [] },
      })?.componentId,
    ).not.toBe("code-diff");
    expect(
      resolveRenderDirective({
        capability: "get_pr_diff",
        output: { files: "nope" },
      })?.componentId,
    ).not.toBe("code-diff");
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
    const recognised = new Set<string>([
      ...Object.keys(RECORD_LINK_ROUTES),
      "graph.edge",
    ]);
    for (const hint of Object.values(CURATED_RENDER_HINTS)) {
      for (const spec of hint.recordLinks ?? []) {
        expect(recognised.has(spec.recordType)).toBe(true);
      }
    }
  });
});
