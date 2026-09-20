import { describe, expect, it } from "vitest";
import {
  alsoGaps,
  computeParity,
  parseContract,
  resolveInvoked,
} from "./check_ui_parity.mjs";

// Two contract fixtures: one declares the "app" layer, one does not.
const CAPS = [
  {
    name: "create_api_key",
    layers: ["api", "mcp", "app"],
    ident: "apiKeyCreate",
  },
  { name: "query_audit_log", layers: ["api", "mcp"], ident: "auditLogQuery" },
  { name: "get_graph_stats", layers: ["api"], ident: "graphStats" },
];
const IDENT_TO_NAME = new Map(CAPS.map((c) => [c.ident, c.name]));
const VALID = new Set(CAPS.map((c) => c.name));

describe("resolveInvoked", () => {
  it("resolves the invoke(<ident>.name, ...) call shape via the ident map", () => {
    const src = `
      const a = await invoke(apiKeyCreate.name, input, ctx);
      const b = await invoke(auditLogQuery.name, input, ctx, { surface: "agent" });
    `;
    const got = resolveInvoked(src, VALID, IDENT_TO_NAME);
    expect(got.has("create_api_key")).toBe(true);
    expect(got.has("query_audit_log")).toBe(true);
    expect(got.size).toBe(2);
  });

  it('resolves the string-literal invoke("name", ...) call shape', () => {
    const src = `await invoke("get_graph_stats", input, ctx);`;
    expect(
      resolveInvoked(src, VALID, IDENT_TO_NAME).has("get_graph_stats"),
    ).toBe(true);
  });

  it("ignores idents/strings that are not registered capabilities", () => {
    const src = `invoke(somethingElse.name, x); invoke("not.a.real.capability", y);`;
    expect(resolveInvoked(src, VALID, IDENT_TO_NAME).size).toBe(0);
  });
});

describe("computeParity — forward gate", () => {
  const pageExists = (p: string) => p === "apps/app/.../real-page.tsx";

  it("flags an app-layer capability with no binding", () => {
    const { forward } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked: new Set(),
      pageExists,
    });
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({ capability: "create_api_key" });
    expect(forward[0]!.reason).toContain("no binding");
  });

  it("flags an app-layer binding whose page is missing on disk", () => {
    const bindings = {
      create_api_key: { page: "apps/app/.../ghost.tsx", proof: "x.png" },
    };
    const { forward } = computeParity({
      caps: CAPS,
      bindings,
      invoked: new Set(),
      pageExists,
    });
    expect(forward[0]!.reason).toContain("missing on disk");
  });

  it("flags a wired binding that carries no runtime proof", () => {
    const bindings = { create_api_key: { page: "apps/app/.../real-page.tsx" } };
    const { forward } = computeParity({
      caps: CAPS,
      bindings,
      invoked: new Set(),
      pageExists,
    });
    expect(forward[0]!.reason).toContain("no runtime `proof`");
  });

  it("passes a fully-wired, proven app-layer capability", () => {
    const bindings = {
      create_api_key: {
        page: "apps/app/.../real-page.tsx",
        proof: "verifications/s/x.png",
      },
    };
    const { forward } = computeParity({
      caps: CAPS,
      bindings,
      invoked: new Set(),
      pageExists,
    });
    expect(forward).toHaveLength(0);
  });
});

describe("computeParity — also, the second page a capability is bound on", () => {
  const pageExists = (p: string) =>
    p === "apps/app/.../real-page.tsx" || p === "apps/app/.../second-page.tsx";
  const primary = {
    page: "apps/app/.../real-page.tsx",
    proof: "apps/app/src/features/x/x.test.tsx",
  };
  const gaps = (also: unknown) =>
    computeParity({
      caps: CAPS,
      bindings: { create_api_key: { ...primary, also } },
      invoked: new Set(),
      pageExists,
    }).forward;

  it("passes a binding whose also entry has a page on disk and a proof", () => {
    expect(
      gaps([
        { page: "apps/app/.../second-page.tsx", proof: "apps/app/b.test.tsx" },
      ]),
    ).toHaveLength(0);
  });

  it("flags an also entry whose page is missing on disk", () => {
    const [gap] = gaps([
      { page: "apps/app/.../ghost.tsx", proof: "apps/app/b.test.tsx" },
    ]);
    expect(gap).toMatchObject({ capability: "create_api_key" });
    expect(gap!.reason).toContain("binding.also[0].page missing on disk");
  });

  it("flags an also entry that carries no runtime proof", () => {
    const [gap] = gaps([{ page: "apps/app/.../second-page.tsx" }]);
    expect(gap!.reason).toContain("binding.also[0] has no runtime `proof`");
  });

  it("reports the index of the failing entry, not the first one", () => {
    const [gap] = gaps([
      { page: "apps/app/.../second-page.tsx", proof: "apps/app/b.test.tsx" },
      { page: "apps/app/.../ghost.tsx", proof: "apps/app/c.test.tsx" },
    ]);
    expect(gap!.reason).toContain("binding.also[1]");
  });

  it("flags a mistyped also rather than skipping it (negative)", () => {
    expect(gaps("apps/app/.../second-page.tsx")[0]!.reason).toContain(
      "binding.also is not an array",
    );
    expect(gaps(["apps/app/.../second-page.tsx"])[0]!.reason).toContain(
      "binding.also[0] is not an object",
    );
  });

  it("judges the primary binding first: a broken primary hides nothing", () => {
    const { forward } = computeParity({
      caps: CAPS,
      bindings: {
        create_api_key: {
          page: "apps/app/.../ghost.tsx",
          proof: "p",
          also: [{ page: "apps/app/.../second-page.tsx", proof: "q" }],
        },
      },
      invoked: new Set(),
      pageExists,
    });
    expect(forward).toHaveLength(1);
    expect(forward[0]!.reason).toContain("binding.page missing on disk");
  });
});

describe("computeParity — ratchet baseline", () => {
  const pageExists = () => false; // every binding.page is missing → gaps

  it("with no baseline, blocking === forward (backward compatible)", () => {
    const { forward, blocking } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked: new Set(),
      pageExists,
    });
    expect(forward).toHaveLength(1); // only create_api_key declares 'app'
    expect(blocking).toEqual(forward);
  });

  it("grandfathers a baselined gap: it stays in forward but leaves blocking", () => {
    const baseline = new Set(["create_api_key"]);
    const { forward, blocking } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked: new Set(),
      pageExists,
      baseline,
    });
    expect(forward.map((g) => g.capability)).toContain("create_api_key");
    expect(blocking).toHaveLength(0); // the ratchet suppresses the strict failure
  });

  it("still blocks a NEW gap not present in the baseline", () => {
    // A second app-layer cap with a gap; baseline only grandfathers the first.
    const caps = [
      ...CAPS,
      { name: "list_secrets", layers: ["api", "app"], ident: "listSecrets" },
    ];
    const baseline = new Set(["create_api_key"]);
    const { blocking } = computeParity({
      caps,
      bindings: {},
      invoked: new Set(),
      pageExists,
      baseline,
    });
    expect(blocking.map((g) => g.capability)).toEqual(["list_secrets"]);
  });
});

describe("computeParity — reverse advisory", () => {
  const pageExists = () => true;

  it("flags a capability the app invokes that never declared the app layer", () => {
    const invoked = new Set(["query_audit_log"]);
    const { reverse } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked,
      pageExists,
    });
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({ capability: "query_audit_log" });
    expect(reverse[0]!.reason).toContain("does not declare the 'app' layer");
  });

  it("flags an app-layer, app-invoked capability that has no binding", () => {
    const invoked = new Set(["create_api_key"]);
    const { reverse } = computeParity({
      caps: CAPS,
      bindings: {},
      invoked,
      pageExists,
    });
    expect(
      reverse.some(
        (r) =>
          r.capability === "create_api_key" && r.reason.includes("no binding"),
      ),
    ).toBe(true);
  });

  it("does not flag an app-invoked capability that is fully declared + bound", () => {
    const invoked = new Set(["create_api_key"]);
    const bindings = { create_api_key: { page: "p", proof: "x" } };
    const { reverse } = computeParity({
      caps: CAPS,
      bindings,
      invoked,
      pageExists,
    });
    expect(reverse).toHaveLength(0);
  });
});

describe("parseContract", () => {
  const SRC = [
    "/**",
    " * List the runs.",
    " *",
    " * A person whose record carries no name: `operatorKind` separates them.",
    ' * Historically this read `layers: ["app"]` in prose too.',
    " */",
    "export const runList = registerCapability({",
    '  name: "list_runs",',
    '  layers: ["schema", "api", "mcp", "app"],',
    "});",
    "",
  ].join("\n");

  it("reads the registered name and layers, not a sentence that mentions them", () => {
    // The regression: an unanchored match read `operatorKind` out of the
    // JSDoc above, and --strict then demanded a page for a capability that
    // does not exist.
    expect(parseContract("run.list.ts", SRC)).toEqual({
      file: "run.list.ts",
      name: "list_runs",
      layers: ["schema", "api", "mcp", "app"],
      hasRegister: true,
      ident: "runList",
    });
  });

  it("falls back to the filename when no contract declares a name (negative)", () => {
    const parsed = parseContract("orphan.ts", "// nothing here\n");
    expect(parsed.name).toBe("orphan");
    expect(parsed.hasRegister).toBe(false);
    expect(parsed.layers).toEqual([]);
    expect(parsed.ident).toBeNull();
  });
});
