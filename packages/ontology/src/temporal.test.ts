import { describe, expect, it } from "vitest";
import {
  buildValidityFilter,
  edgeCloseOnSupersedeSet,
  edgeCloseParams,
  edgeOpenPredicate,
  edgeValidityOnCreateSet,
  edgeValidityOnMatchSet,
  edgeValidityParams,
  edgeValidityReturn,
  readEdgeValidity,
  type EdgeValidity,
} from "./temporal";

describe("edgeValidityOnCreateSet", () => {
  it("stamps validFrom (with now fallback), open bounds, and recordedAt=now", () => {
    const frag = edgeValidityOnCreateSet("r");
    expect(frag).toContain(
      "r.validFrom = coalesce(datetime($validFrom), datetime())",
    );
    expect(frag).toContain("r.validTo = null");
    expect(frag).toContain("r.recordedAt = datetime()");
    expect(frag).toContain("r.invalidatedAt = null");
    // No leading/trailing comma so it composes inside an existing SET list.
    expect(frag.trim().startsWith(",")).toBe(false);
    expect(frag.trim().endsWith(",")).toBe(false);
  });

  it("honours a custom relationship variable", () => {
    expect(edgeValidityOnCreateSet("edge")).toContain("edge.validFrom");
  });

  it("rejects an unsafe variable name", () => {
    expect(() => edgeValidityOnCreateSet("r; DROP")).toThrow(
      /unsafe Cypher variable/,
    );
  });
});

describe("edgeValidityOnMatchSet", () => {
  it("preserves lower bounds and reopens upper bounds on re-assertion", () => {
    const frag = edgeValidityOnMatchSet("r");
    expect(frag).toContain(
      "r.validFrom = coalesce(r.validFrom, datetime($validFrom), datetime())",
    );
    expect(frag).toContain("r.recordedAt = coalesce(r.recordedAt, datetime())");
    expect(frag).toContain("r.validTo = null");
    expect(frag).toContain("r.invalidatedAt = null");
  });
});

describe("edgeCloseOnSupersedeSet / edgeOpenPredicate", () => {
  it("closes both axes idempotently via coalesce", () => {
    const frag = edgeCloseOnSupersedeSet("old");
    expect(frag).toContain(
      "old.validTo = coalesce(old.validTo, datetime($closedAt))",
    );
    expect(frag).toContain(
      "old.invalidatedAt = coalesce(old.invalidatedAt, datetime($closedAt))",
    );
  });

  it("open predicate selects only unclosed edges", () => {
    expect(edgeOpenPredicate("old")).toBe(
      "old.validTo IS NULL AND old.invalidatedAt IS NULL",
    );
  });
});

describe("edgeValidityParams", () => {
  it("passes through an ISO observed time", () => {
    expect(edgeValidityParams("2024-01-01T00:00:00.000Z")).toEqual({
      validFrom: "2024-01-01T00:00:00.000Z",
    });
  });

  it("normalises a Date", () => {
    const d = new Date("2024-06-15T12:00:00.000Z");
    expect(edgeValidityParams(d)).toEqual({
      validFrom: "2024-06-15T12:00:00.000Z",
    });
  });

  it("returns null when observed time is unknown (Cypher falls back to now)", () => {
    expect(edgeValidityParams()).toEqual({ validFrom: null });
    expect(edgeValidityParams(null)).toEqual({ validFrom: null });
    expect(edgeValidityParams("  ")).toEqual({ validFrom: null });
  });
});

describe("edgeCloseParams", () => {
  it("uses the supplied close time", () => {
    expect(edgeCloseParams("2024-02-02T00:00:00.000Z")).toEqual({
      closedAt: "2024-02-02T00:00:00.000Z",
    });
  });

  it("defaults to now when omitted", () => {
    const before = Date.now();
    const { closedAt } = edgeCloseParams();
    const t = new Date(closedAt).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 1000);
  });
});

describe("buildValidityFilter", () => {
  it("defaults both axes to now so callers see currently-valid, currently-known facts", () => {
    const before = Date.now();
    const { clause, params } = buildValidityFilter("r");
    // Valid-time bounds.
    expect(clause).toContain(
      "(r.validFrom IS NULL OR r.validFrom <= datetime($asOf))",
    );
    expect(clause).toContain(
      "(r.validTo IS NULL OR r.validTo > datetime($asOf))",
    );
    // Transaction-time bounds.
    expect(clause).toContain(
      "(r.recordedAt IS NULL OR r.recordedAt <= datetime($asKnownAt))",
    );
    expect(clause).toContain(
      "(r.invalidatedAt IS NULL OR r.invalidatedAt > datetime($asKnownAt))",
    );
    expect(new Date(params.asOf).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(new Date(params.asKnownAt).getTime()).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });

  it("threads explicit asOf / asKnownAt through as params", () => {
    const { params } = buildValidityFilter("rel", {
      asOf: "2020-01-01T00:00:00.000Z",
      asKnownAt: "2021-01-01T00:00:00.000Z",
    });
    expect(params).toEqual({
      asOf: "2020-01-01T00:00:00.000Z",
      asKnownAt: "2021-01-01T00:00:00.000Z",
    });
  });

  it("keeps null lower bounds valid so unstamped legacy edges are behaviour-preserving", () => {
    // The IS NULL disjuncts mean an edge with no validFrom/recordedAt always passes.
    const { clause } = buildValidityFilter("rel");
    expect(clause).toContain("rel.validFrom IS NULL");
    expect(clause).toContain("rel.recordedAt IS NULL");
  });

  it("rejects an unsafe variable name", () => {
    expect(() => buildValidityFilter("rel)--")).toThrow(
      /unsafe Cypher variable/,
    );
  });
});

describe("edgeValidityReturn / readEdgeValidity", () => {
  it("projects prefixed ISO columns and reads them back", () => {
    const projection = edgeValidityReturn("r", "edge");
    expect(projection).toContain("toString(r.validFrom) AS edgevalidFrom");
    expect(projection).toContain(
      "toString(r.invalidatedAt) AS edgeinvalidatedAt",
    );

    const row: Record<string, unknown> = {
      edgevalidFrom: "2024-01-01T00:00:00.000Z",
      edgevalidTo: null,
      edgerecordedAt: "2024-01-02T00:00:00.000Z",
      edgeinvalidatedAt: null,
    };
    const validity: EdgeValidity = readEdgeValidity((k) => row[k], "edge");
    expect(validity).toEqual({
      validFrom: "2024-01-01T00:00:00.000Z",
      validTo: null,
      recordedAt: "2024-01-02T00:00:00.000Z",
      invalidatedAt: null,
    });
  });

  it("rejects an unsafe column-alias prefix", () => {
    expect(() => edgeValidityReturn("r", "x, n.secret AS leak, y")).toThrow(
      /unsafe Cypher column-alias prefix/,
    );
  });

  it("treats empty strings and missing columns as null", () => {
    const validity = readEdgeValidity((k) =>
      k === "validFrom" ? "" : undefined,
    );
    expect(validity).toEqual({
      validFrom: null,
      validTo: null,
      recordedAt: null,
      invalidatedAt: null,
    });
  });
});
