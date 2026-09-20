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

describe("computeParity — a second page in `also`", () => {
  const pageExists = (p: string) =>
    p === "apps/app/.../real-page.tsx" || p === "apps/app/.../fleet.tsx";
  const primary = {
    page: "apps/app/.../real-page.tsx",
    proof: "verifications/s/x.png",
  };

  it("passes a second surface whose page exists and carries a proof", () => {
    const bindings = {
      create_api_key: {
        ...primary,
        also: [
          {
            route: "/[org]/[ws]",
            page: "apps/app/.../fleet.tsx",
            proof: "apps/app/src/features/fleet/row.test.tsx",
          },
        ],
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

  it("flags an `also` page that is not on disk", () => {
    const bindings = {
      create_api_key: {
        ...primary,
        also: [{ page: "apps/app/.../ghost.tsx", proof: "x.test.tsx" }],
      },
    };
    const { forward } = computeParity({
      caps: CAPS,
      bindings,
      invoked: new Set(),
      pageExists,
    });
    expect(forward).toHaveLength(1);
    expect(forward[0]!.reason).toContain("also[0].page missing on disk");
  });

  it("flags an `also` entry with no proof, the way the primary binding is", () => {
    const bindings = {
      create_api_key: {
        ...primary,
        also: [{ page: "apps/app/.../fleet.tsx" }],
      },
    };
    const { forward } = computeParity({
      caps: CAPS,
      bindings,
      invoked: new Set(),
      pageExists,
    });
    expect(forward[0]!.reason).toContain("also[0] has no runtime `proof`");
  });

  it("blocks under the ratchet like any other forward gap", () => {
    const bindings = {
      create_api_key: {
        ...primary,
        also: [{ page: "apps/app/.../ghost.tsx", proof: "x.test.tsx" }],
      },
    };
    const { blocking } = computeParity({
      caps: CAPS,
      bindings,
      invoked: new Set(),
      pageExists,
      baseline: new Set(),
    });
    expect(blocking.map((g) => g.capability)).toEqual(["create_api_key"]);
  });
});

describe("alsoGaps", () => {
  const pageExists = (p: string) => p === "real.tsx";

  it("treats a binding with no `also` as no gap, so one-surface bindings are unchanged", () => {
    expect(alsoGaps("create_api_key", undefined, pageExists)).toEqual([]);
  });

  it("rejects an `also` that is not an array (negative)", () => {
    const gaps = alsoGaps("create_api_key", { page: "real.tsx" }, pageExists);
    expect(gaps[0]!.reason).toContain("not an array");
  });

  it("rejects an entry that is not an object (negative)", () => {
    const gaps = alsoGaps("create_api_key", ["real.tsx"], pageExists);
    expect(gaps[0]!.reason).toContain("not a {route, page, proof} object");
  });

  it("reports every bad entry with its index, not only the first", () => {
    const gaps = alsoGaps(
      "create_api_key",
      [{ page: "gone.tsx", proof: "p" }, { page: "real.tsx" }],
      pageExists,
    );
    expect(gaps.map((g) => g.reason)).toEqual([
      expect.stringContaining("also[0].page missing on disk"),
      expect.stringContaining("also[1] has no runtime `proof`"),
    ]);
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
