import { describe, expect, it } from "vitest";
import { resolveInvoked, computeParity } from "./check_ui_parity.mjs";

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
