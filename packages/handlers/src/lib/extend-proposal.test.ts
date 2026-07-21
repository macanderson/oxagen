import { describe, it, expect } from "vitest";
import { HTTPException } from "hono/http-exception";
import type { PinnedSchema, PinnedProperty } from "@oxagen/ingestion/validate";
import type { GraphScope } from "@oxagen/ontology/graph-scope";
import {
  assertProposalWithinScope,
  assertProposalInVocabulary,
  assertProposalComplete,
  ExtendProposalScopeError,
  PropertyCompletenessError,
} from "./extend-proposal";

// ── fixtures ──────────────────────────────────────────────────────────────────

function prop(key: string, required: boolean): PinnedProperty {
  return {
    key,
    dataType: "string",
    required,
    description: null,
    enumValues: null,
    itemType: null,
    constraints: {},
    example: null,
  };
}

function pinned(
  enforcementMode: PinnedSchema["enforcementMode"],
  opts: {
    labels?: Array<{ name: string; props?: PinnedProperty[] }>;
    rels?: Array<{ name: string; props?: PinnedProperty[] }>;
  } = {},
): PinnedSchema {
  return {
    registryId: "reg_1",
    versionId: "ver_1",
    versionNumber: 1,
    enforcementMode,
    conformanceFloor: 0,
    labels: (opts.labels ?? []).map((l) => ({
      schemaName: "s",
      name: l.name,
      displayName: l.name,
      description: null,
      naturalKeyProps: [],
      properties: l.props ?? [],
    })),
    relationshipTypes: (opts.rels ?? []).map((r) => ({
      schemaName: "s",
      name: r.name,
      displayName: r.name,
      description: null,
      startLabel: null,
      endLabel: null,
      cardinality: null,
      properties: r.props ?? [],
    })),
  };
}

// ── assertProposalWithinScope (Q3 a/b — the RBAC ceiling) ───────────────────────

describe("assertProposalWithinScope", () => {
  it("no-ops when no agent scope is active (human / API-key / legacy write)", () => {
    expect(() =>
      assertProposalWithinScope({ label: "Anything" }, undefined),
    ).not.toThrow();
  });

  it("rejects any proposal under a read-mode scope (extend not granted)", () => {
    const scope: GraphScope = { mode: "read", labels: ["Feature"] };
    try {
      assertProposalWithinScope({ label: "Feature" }, scope);
      expect.unreachable("read-mode must reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtendProposalScopeError);
      const e = err as ExtendProposalScopeError;
      expect(e.code).toBe("extend_proposal_out_of_scope");
      expect(e.dimension).toBe("mode");
      expect(e.status).toBe(422);
      expect(err).toBeInstanceOf(HTTPException);
    }
  });

  it("rejects a label outside the allow-list and reports the allowed set", () => {
    const scope: GraphScope = {
      mode: "extend",
      labels: ["Feature", "Service"],
    };
    try {
      assertProposalWithinScope({ label: "Secret" }, scope);
      expect.unreachable("out-of-scope label must reject");
    } catch (err) {
      const e = err as ExtendProposalScopeError;
      expect(e.dimension).toBe("label");
      expect(e.value).toBe("Secret");
      expect(e.allowed).toEqual(["Feature", "Service"]);
    }
  });

  it("permits an in-scope label", () => {
    const scope: GraphScope = { mode: "extend", labels: ["Feature"] };
    expect(() =>
      assertProposalWithinScope({ label: "Feature" }, scope),
    ).not.toThrow();
  });

  it("skips the label check for a relationship-only proposal (label undefined)", () => {
    const scope: GraphScope = { mode: "extend", labels: ["Feature"] };
    // graph.edge.upsert: endpoints pre-exist, no proposed node label.
    expect(() =>
      assertProposalWithinScope(
        { relationshipType: "DEPENDS_ON" },
        { ...scope, relationshipTypes: ["DEPENDS_ON"] },
      ),
    ).not.toThrow();
  });

  it("rejects an out-of-scope relationship type", () => {
    const scope: GraphScope = {
      mode: "extend",
      relationshipTypes: ["DEPENDS_ON"],
    };
    try {
      assertProposalWithinScope(
        { label: "Feature", relationshipType: "OWNS" },
        scope,
      );
      expect.unreachable("out-of-scope rel type must reject");
    } catch (err) {
      const e = err as ExtendProposalScopeError;
      expect(e.dimension).toBe("relationshipType");
      expect(e.value).toBe("OWNS");
    }
  });

  it("treats an undefined dimension as unrestricted", () => {
    const scope: GraphScope = { mode: "extend" }; // no labels/relTypes → all allowed
    expect(() =>
      assertProposalWithinScope(
        { label: "Anything", relationshipType: "ANYTHING" },
        scope,
      ),
    ).not.toThrow();
  });
});

// ── assertProposalInVocabulary (Q3 b — strict workspace vocabulary) ─────────────

describe("assertProposalInVocabulary", () => {
  it("no-ops when the schema is not strict, even for an unknown label", () => {
    for (const mode of ["lenient", "off"] as const) {
      expect(() =>
        assertProposalInVocabulary(
          { label: "Unknown" },
          pinned(mode, { labels: [{ name: "Feature" }] }),
        ),
      ).not.toThrow();
    }
    expect(() =>
      assertProposalInVocabulary({ label: "Unknown" }, null),
    ).not.toThrow();
  });

  it("rejects an out-of-vocabulary label under strict enforcement", () => {
    expect(() =>
      assertProposalInVocabulary(
        { label: "Unknown" },
        pinned("strict", { labels: [{ name: "Feature" }] }),
      ),
    ).toThrow(ExtendProposalScopeError);
  });

  it("permits an in-vocabulary label + relationship type under strict", () => {
    expect(() =>
      assertProposalInVocabulary(
        { label: "Feature", relationshipType: "DEPENDS_ON" },
        pinned("strict", {
          labels: [{ name: "Feature" }],
          rels: [{ name: "DEPENDS_ON" }],
        }),
      ),
    ).not.toThrow();
  });

  it("skips the label check when no label is supplied (relationship-only)", () => {
    expect(() =>
      assertProposalInVocabulary(
        { relationshipType: "DEPENDS_ON" },
        pinned("strict", {
          labels: [{ name: "Feature" }],
          rels: [{ name: "DEPENDS_ON" }],
        }),
      ),
    ).not.toThrow();
  });
});

// ── assertProposalComplete (Q3 c — property completeness) ───────────────────────

describe("assertProposalComplete", () => {
  it("no-ops when the schema is not strict", () => {
    const schema = pinned("lenient", {
      labels: [{ name: "Feature", props: [prop("title", true)] }],
    });
    expect(() =>
      assertProposalComplete({ label: "Feature", properties: {} }, schema),
    ).not.toThrow();
  });

  it("rejects an incomplete node and lists the missing required properties", () => {
    const schema = pinned("strict", {
      labels: [
        {
          name: "Feature",
          props: [
            prop("title", true),
            prop("owner", true),
            prop("notes", false),
          ],
        },
      ],
    });
    try {
      assertProposalComplete(
        { label: "Feature", properties: { title: "Login" } },
        schema,
      );
      expect.unreachable("incomplete node must reject");
    } catch (err) {
      expect(err).toBeInstanceOf(PropertyCompletenessError);
      const e = err as PropertyCompletenessError;
      expect(e.code).toBe("extend_proposal_incomplete_properties");
      expect(e.targetKind).toBe("node");
      expect(e.label).toBe("Feature");
      expect(e.missingProperties).toEqual(["owner"]); // title present, notes optional
      expect(e.status).toBe(422);
    }
  });

  it("passes a node that populates every required property", () => {
    const schema = pinned("strict", {
      labels: [
        { name: "Feature", props: [prop("title", true), prop("owner", true)] },
      ],
    });
    expect(() =>
      assertProposalComplete(
        { label: "Feature", properties: { title: "Login", owner: "team-x" } },
        schema,
      ),
    ).not.toThrow();
  });

  it("passes through an unknown label (no declared schema to complete)", () => {
    const schema = pinned("strict", { labels: [{ name: "Feature" }] });
    expect(() =>
      assertProposalComplete({ label: "Mystery", properties: {} }, schema),
    ).not.toThrow();
  });

  it("rejects an incomplete relationship property bag", () => {
    const schema = pinned("strict", {
      labels: [{ name: "Feature" }],
      rels: [{ name: "DEPENDS_ON", props: [prop("since", true)] }],
    });
    try {
      assertProposalComplete(
        {
          label: "Feature",
          properties: {},
          relationshipType: "DEPENDS_ON",
          relationshipProperties: {},
        },
        schema,
      );
      expect.unreachable("incomplete relationship must reject");
    } catch (err) {
      const e = err as PropertyCompletenessError;
      expect(e.targetKind).toBe("relationship");
      expect(e.label).toBe("DEPENDS_ON");
      expect(e.missingProperties).toEqual(["since"]);
    }
  });
});
