import { describe, expect, it } from "vitest";
import { resolveInvoked, computeParity } from "./check_ui_parity.mjs";

// Two contract fixtures: one declares the "app" layer, one does not.
const CAPS = [
  { name: "api.key.create", layers: ["api", "mcp", "app"], ident: "apiKeyCreate" },
  { name: "audit.log.query", layers: ["api", "mcp"], ident: "auditLogQuery" },
  { name: "graph.stats", layers: ["api"], ident: "graphStats" },
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
    expect(got.has("api.key.create")).toBe(true);
    expect(got.has("audit.log.query")).toBe(true);
    expect(got.size).toBe(2);
  });

  it("resolves the string-literal invoke(\"name\", ...) call shape", () => {
    const src = `await invoke("graph.stats", input, ctx);`;
    expect(resolveInvoked(src, VALID, IDENT_TO_NAME).has("graph.stats")).toBe(true);
  });

  it("ignores idents/strings that are not registered capabilities", () => {
    const src = `invoke(somethingElse.name, x); invoke("not.a.real.capability", y);`;
    expect(resolveInvoked(src, VALID, IDENT_TO_NAME).size).toBe(0);
  });
});

describe("computeParity — forward gate", () => {
  const pageExists = (p: string) => p === "apps/app/.../real-page.tsx";

  it("flags an app-layer capability with no binding", () => {
    const { forward } = computeParity({ caps: CAPS, bindings: {}, invoked: new Set(), pageExists });
    expect(forward).toHaveLength(1);
    expect(forward[0]).toMatchObject({ capability: "api.key.create" });
    expect(forward[0].reason).toContain("no binding");
  });

  it("flags an app-layer binding whose page is missing on disk", () => {
    const bindings = { "api.key.create": { page: "apps/app/.../ghost.tsx", proof: "x.png" } };
    const { forward } = computeParity({ caps: CAPS, bindings, invoked: new Set(), pageExists });
    expect(forward[0].reason).toContain("missing on disk");
  });

  it("flags a wired binding that carries no runtime proof", () => {
    const bindings = { "api.key.create": { page: "apps/app/.../real-page.tsx" } };
    const { forward } = computeParity({ caps: CAPS, bindings, invoked: new Set(), pageExists });
    expect(forward[0].reason).toContain("no runtime `proof`");
  });

  it("passes a fully-wired, proven app-layer capability", () => {
    const bindings = { "api.key.create": { page: "apps/app/.../real-page.tsx", proof: "verifications/s/x.png" } };
    const { forward } = computeParity({ caps: CAPS, bindings, invoked: new Set(), pageExists });
    expect(forward).toHaveLength(0);
  });
});

describe("computeParity — reverse advisory", () => {
  const pageExists = () => true;

  it("flags a capability the app invokes that never declared the app layer", () => {
    const invoked = new Set(["audit.log.query"]);
    const { reverse } = computeParity({ caps: CAPS, bindings: {}, invoked, pageExists });
    expect(reverse).toHaveLength(1);
    expect(reverse[0]).toMatchObject({ capability: "audit.log.query" });
    expect(reverse[0].reason).toContain("does not declare the 'app' layer");
  });

  it("flags an app-layer, app-invoked capability that has no binding", () => {
    const invoked = new Set(["api.key.create"]);
    const { reverse } = computeParity({ caps: CAPS, bindings: {}, invoked, pageExists });
    expect(reverse.some((r) => r.capability === "api.key.create" && r.reason.includes("no binding"))).toBe(true);
  });

  it("does not flag an app-invoked capability that is fully declared + bound", () => {
    const invoked = new Set(["api.key.create"]);
    const bindings = { "api.key.create": { page: "p", proof: "x" } };
    const { reverse } = computeParity({ caps: CAPS, bindings, invoked, pageExists });
    expect(reverse).toHaveLength(0);
  });
});
