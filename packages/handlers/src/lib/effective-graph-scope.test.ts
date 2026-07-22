import { describe, it, expect } from "vitest";
import type { CheckedContext } from "@oxagen/oxagen";
import type { EffectivePermissions } from "@oxagen/oxagen/iam";
import type { GraphAccess } from "@oxagen/oxagen/agent-schema";
import type { GraphScope } from "@oxagen/ontology/graph-scope";
import {
  declaredGraphScope,
  effectiveGraphScope,
  nodeOnlyGraphScope,
} from "./effective-graph-scope";

const CAP = "ontology.neighbors";

/** Build a GraphAccess declaration fixture (agent-schema shape). */
function ga(opts: {
  mode?: "read" | "extend";
  scopeToTypes?: string[];
  maxHops?: number;
  maxNodes?: number;
  maxTraversalMs?: number;
}): GraphAccess {
  return {
    mode: opts.mode ?? "read",
    retrieval: {
      ...(opts.scopeToTypes !== undefined
        ? { scopeToTypes: opts.scopeToTypes }
        : {}),
    },
    budget: {
      maxHops: opts.maxHops ?? 3,
      maxNodes: opts.maxNodes ?? 100,
      ...(opts.maxTraversalMs !== undefined
        ? { maxTraversalMs: opts.maxTraversalMs }
        : {}),
    },
  } as GraphAccess;
}

/**
 * Minimal CheckedContext carrying an agentRun with the cached per-capability
 * resolution + the definition's graphAccess. `ceiling === null` means an
 * agentRun with a resolution entry but no graph ceiling; omit `ceiling` for no
 * agentRun at all.
 */
function ctxWith(opts: {
  ceiling?: GraphScope | null;
  graphAccess?: GraphAccess;
}): CheckedContext {
  if (opts.ceiling === undefined && opts.graphAccess === undefined) {
    return {} as unknown as CheckedContext; // no agentRun
  }
  const byCapability = new Map<string, EffectivePermissions>();
  byCapability.set(CAP, {
    outcome: "allow",
    agentResolution: {},
    humanResolution: {},
    resourceScope: {
      graph: opts.ceiling === null ? undefined : opts.ceiling,
    },
  } as unknown as EffectivePermissions);
  return {
    agentRun: {
      resolution: { byCapability },
      graphAccess: opts.graphAccess,
    },
  } as unknown as CheckedContext;
}

// ── declaredGraphScope ──────────────────────────────────────────────────────────

describe("declaredGraphScope", () => {
  it("returns undefined for an undefined declaration", () => {
    expect(declaredGraphScope(undefined)).toBeUndefined();
  });

  it("maps scopeToTypes onto BOTH labels and relationshipTypes", () => {
    const scope = declaredGraphScope(ga({ scopeToTypes: ["Feature", "OWNS"] }));
    expect(scope?.labels).toEqual(["Feature", "OWNS"]);
    expect(scope?.relationshipTypes).toEqual(["Feature", "OWNS"]);
  });

  it("leaves both type dimensions unconstrained when scopeToTypes is empty", () => {
    const scope = declaredGraphScope(ga({ scopeToTypes: [] }));
    expect(scope?.labels).toBeUndefined();
    expect(scope?.relationshipTypes).toBeUndefined();
  });

  it("always maps mode and budget", () => {
    const scope = declaredGraphScope(
      ga({ mode: "extend", maxHops: 2, maxNodes: 50, maxTraversalMs: 1000 }),
    );
    expect(scope?.mode).toBe("extend");
    expect(scope?.budget).toEqual({
      maxHops: 2,
      maxNodes: 50,
      maxTraversalMs: 1000,
    });
  });

  it("omits maxTraversalMs when the declaration does not set it", () => {
    const scope = declaredGraphScope(ga({ maxHops: 1, maxNodes: 10 }));
    expect(scope?.budget).toEqual({ maxHops: 1, maxNodes: 10 });
    expect(scope?.budget && "maxTraversalMs" in scope.budget).toBe(false);
  });
});

// ── effectiveGraphScope (role ceiling ∩ declaration) ───────────────────────────

describe("effectiveGraphScope", () => {
  it("returns undefined when there is no agentRun (human / API-key call)", () => {
    expect(effectiveGraphScope(ctxWith({}), CAP)).toBeUndefined();
  });

  it("returns undefined when fully unrestricted (no ceiling, no declaration)", () => {
    expect(
      effectiveGraphScope(ctxWith({ ceiling: null }), CAP),
    ).toBeUndefined();
  });

  it("returns the role ceiling when there is no declaration", () => {
    const ceiling: GraphScope = { mode: "extend", labels: ["A", "B"] };
    const eff = effectiveGraphScope(ctxWith({ ceiling }), CAP);
    expect(eff?.labels).toEqual(["A", "B"]);
    expect(eff?.mode).toBe("extend");
  });

  it("intersects ceiling labels with the declaration's scopeToTypes", () => {
    const ceiling: GraphScope = { mode: "extend", labels: ["A", "B"] };
    const eff = effectiveGraphScope(
      ctxWith({
        ceiling,
        graphAccess: ga({ mode: "extend", scopeToTypes: ["B", "C"] }),
      }),
      CAP,
    );
    expect(eff?.labels).toEqual(["B"]); // set intersection
  });

  it("takes the more restrictive mode (read declaration narrows extend ceiling)", () => {
    const ceiling: GraphScope = { mode: "extend", labels: ["A"] };
    const eff = effectiveGraphScope(
      ctxWith({
        ceiling,
        graphAccess: ga({ mode: "read", scopeToTypes: ["A"] }),
      }),
      CAP,
    );
    expect(eff?.mode).toBe("read");
  });

  it("takes the element-wise minimum budget", () => {
    const ceiling: GraphScope = {
      mode: "extend",
      budget: { maxHops: 5, maxNodes: 1000 },
    };
    const eff = effectiveGraphScope(
      ctxWith({
        ceiling,
        graphAccess: ga({ mode: "extend", maxHops: 2, maxNodes: 5000 }),
      }),
      CAP,
    );
    expect(eff?.budget?.maxHops).toBe(2); // min(5, 2)
    expect(eff?.budget?.maxNodes).toBe(1000); // min(1000, 5000)
  });
});

// ── nodeOnlyGraphScope ──────────────────────────────────────────────────────────

describe("nodeOnlyGraphScope", () => {
  it("returns undefined for an undefined scope", () => {
    expect(nodeOnlyGraphScope(undefined)).toBeUndefined();
  });

  it("returns the scope unchanged when it has no relationshipTypes", () => {
    const scope: GraphScope = { mode: "read", labels: ["A"] };
    expect(nodeOnlyGraphScope(scope)).toBe(scope);
  });

  it("drops relationshipTypes but preserves labels, mode, and budget", () => {
    const scope: GraphScope = {
      mode: "extend",
      labels: ["A"],
      relationshipTypes: ["R"],
      budget: { maxHops: 2 },
    };
    const narrowed = nodeOnlyGraphScope(scope);
    expect(narrowed?.relationshipTypes).toBeUndefined();
    expect(narrowed?.labels).toEqual(["A"]);
    expect(narrowed?.mode).toBe("extend");
    expect(narrowed?.budget).toEqual({ maxHops: 2 });
  });
});
