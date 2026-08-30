import { describe, it, expect } from "vitest";
import {
  detectSimpleIntents,
  describeMutations,
  dedupeMutations,
  buildProposedMutations,
} from "./schema.chat";

// buildProposedMutations is typed against the LLM response shape; tests pass
// plain literals (the same pattern the suite uses for DraftSchema), so a thin
// alias keeps the calls type-clean without exporting internal types.
type ChatResponse = Parameters<typeof buildProposedMutations>[0];
const resp = (o: Record<string, unknown>): ChatResponse =>
  o as unknown as ChatResponse;
type Mutation = { capability: string; input: Record<string, unknown> };
const mut = (capability: string, input: Record<string, unknown>): Mutation => ({
  capability,
  input,
});

const SCHEMAS = [
  { name: "support", labels: ["SupportTicket", "Bug"], rels: [] },
  { name: "subscription", labels: ["Subscription", "Plan"], rels: [] },
  { name: "billing", labels: ["Invoice", "Payment"], rels: [] },
];

describe("detectSimpleIntents — deterministic schema-edit parsing", () => {
  it("drops a schema (drop/delete/remove + name, plural-tolerant)", () => {
    for (const msg of [
      "drop the support schema entirely",
      "delete the support schema",
      "remove the supports schema",
    ]) {
      expect(detectSimpleIntents(msg, SCHEMAS)).toEqual([
        { capability: "delete_schema", input: { schemaName: "support" } },
      ]);
    }
  });

  it("disables / enables a schema", () => {
    expect(detectSimpleIntents("disable the billing schema", SCHEMAS)).toEqual([
      {
        capability: "toggle_schema",
        input: { schemaName: "billing", enabled: false },
      },
    ]);
    expect(detectSimpleIntents("deactivate subscription", SCHEMAS)).toEqual([
      {
        capability: "toggle_schema",
        input: { schemaName: "subscription", enabled: false },
      },
    ]);
    expect(detectSimpleIntents("enable the billing schema", SCHEMAS)).toEqual([
      {
        capability: "toggle_schema",
        input: { schemaName: "billing", enabled: true },
      },
    ]);
    expect(detectSimpleIntents("turn on subscription", SCHEMAS)).toEqual([
      {
        capability: "toggle_schema",
        input: { schemaName: "subscription", enabled: true },
      },
    ]);
  });

  it("adds properties to a schema, inferring dataType and the matching label", () => {
    const out = detectSimpleIntents(
      "add a number_of_licenses field and a customer_since field to the subscriptions schema",
      SCHEMAS,
    );
    expect(out).toEqual([
      {
        capability: "upsert_schema_property",
        input: {
          schemaName: "subscription",
          ownerKind: "node",
          ownerName: "Subscription",
          key: "number_of_licenses",
          dataType: "integer",
          required: false,
        },
      },
      {
        capability: "upsert_schema_property",
        input: {
          schemaName: "subscription",
          ownerKind: "node",
          ownerName: "Subscription",
          key: "customer_since",
          dataType: "date",
          required: false,
        },
      },
    ]);
  });

  it("returns [] for create/open-ended asks (LLM path handles those)", () => {
    expect(
      detectSimpleIntents(
        "generate the schemas for a b2b saas company",
        SCHEMAS,
      ),
    ).toEqual([]);
    expect(detectSimpleIntents("what schemas do I have?", SCHEMAS)).toEqual([]);
  });

  it("returns [] when no real schema name is referenced (no false positives)", () => {
    expect(detectSimpleIntents("drop the marketing schema", SCHEMAS)).toEqual(
      [],
    );
    expect(detectSimpleIntents("disable everything", SCHEMAS)).toEqual([]);
  });

  it("returns [] when the draft is empty", () => {
    expect(detectSimpleIntents("drop the support schema", [])).toEqual([]);
  });

  it("infers data types from field-name shape across all rules", () => {
    const out = detectSimpleIntents(
      "add is_active, signed_at, created_time, total_amount, contact_email, profile_url, plan_name fields to the support schema",
      SCHEMAS,
    );
    const byKey = Object.fromEntries(
      out.map((m) => [m.input.key, m.input.dataType]),
    );
    expect(byKey.is_active).toBe("boolean");
    expect(byKey.signed_at).toBe("date");
    expect(byKey.created_time).toBe("datetime");
    expect(byKey.total_amount).toBe("number");
    expect(byKey.contact_email).toBe("email");
    expect(byKey.profile_url).toBe("url");
    expect(byKey.plan_name).toBe("string");
  });
});

describe("describeMutations — assistant reply summary", () => {
  it("summarizes property upserts (singular vs plural) with schema name + keys", () => {
    expect(
      describeMutations([
        mut("upsert_schema_property", { schemaName: "billing", key: "tax_id" }),
      ]),
    ).toContain("Added 1 property (`tax_id`) to the billing schema.");
    const many = describeMutations([
      mut("upsert_schema_property", { schemaName: "billing", key: "a" }),
      mut("upsert_schema_property", { schemaName: "billing", key: "b" }),
    ]);
    expect(many).toContain("Added 2 properties (`a`, `b`)");
  });

  it("summarizes delete / toggle / label-delete and falls back when empty", () => {
    expect(
      describeMutations([mut("delete_schema", { schemaName: "support" })]),
    ).toContain("Dropped the support schema.");
    expect(
      describeMutations([
        mut("toggle_schema", { schemaName: "billing", enabled: true }),
      ]),
    ).toContain("Activated the billing schema.");
    expect(
      describeMutations([
        mut("toggle_schema", { schemaName: "billing", enabled: false }),
      ]),
    ).toContain("Deactivated the billing schema.");
    expect(
      describeMutations([
        mut("delete_schema_label", { schemaName: "billing", name: "Invoice" }),
      ]),
    ).toContain("Removed the Invoice label from billing.");
    expect(describeMutations([])).toBe("Applied the requested change.");
  });
});

describe("dedupeMutations — keep the first of each logical mutation", () => {
  it("drops later duplicates keyed by capability + identity fields", () => {
    const out = dedupeMutations([
      mut("delete_schema", { schemaName: "support" }),
      mut("delete_schema", { schemaName: "support" }),
      mut("upsert_schema_property", {
        schemaName: "billing",
        ownerName: "Invoice",
        key: "tax_id",
      }),
      mut("upsert_schema_property", {
        schemaName: "billing",
        ownerName: "Invoice",
        key: "tax_id",
      }),
      mut("upsert_schema_property", {
        schemaName: "billing",
        ownerName: "Invoice",
        key: "total",
      }),
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((m) => m.input.key).filter(Boolean)).toEqual([
      "tax_id",
      "total",
    ]);
  });
});

describe("buildProposedMutations — LLM structured output → normalized mutations", () => {
  it("builds label + relationship upserts from a schema scaffold, normalizing names/types", () => {
    const out = buildProposedMutations(
      resp({
        assistantMessage: "ok",
        schemas: [
          {
            name: "  crm  ",
            labels: [
              {
                name: "Customer",
                properties: [
                  { key: "lifetime_value", dataType: "decimal" },
                  { key: "name" },
                ],
              },
            ],
            relationshipTypes: [
              {
                name: "places order",
                startLabel: "Customer",
                endLabel: "Order",
                cardinality: "many_to_one",
              },
            ],
          },
        ],
      }),
    );
    const label = out.find((m) => m.capability === "upsert_schema_label");
    expect(label?.input.schemaName).toBe("crm"); // trimmed
    expect(label?.input.displayName).toBe("Customer"); // humanized fallback
    const props = label?.input.properties as Array<Record<string, unknown>>;
    expect(props[0]?.dataType).toBe("number"); // "decimal" synonym → number
    expect(props[0]?.required).toBe(false); // defaulted
    expect(props[1]?.dataType).toBe("string"); // missing dataType → string

    const rel = out.find((m) => m.capability === "upsert_schema_relationship");
    expect(rel?.input.name).toBe("PLACES_ORDER"); // normalizeRelName
    expect(rel?.input.displayName).toBe("Places Order"); // humanize
    expect(rel?.input.cardinality).toBe("one_to_many"); // many_to_one → one_to_many
  });

  it("passes through targeted mutations and drops ones missing identity", () => {
    const out = buildProposedMutations(
      resp({
        assistantMessage: "ok",
        mutations: [
          {
            capability: "delete_schema_label",
            input: { schemaName: "billing", name: "Invoice" },
          },
          {
            capability: "delete_schema_label",
            input: { schemaName: "billing" },
          }, // no name → dropped
          {
            capability: "upsert_schema_property",
            input: {
              schemaName: "billing",
              ownerName: "Invoice",
              key: "tax_id",
            },
          },
          {
            capability: "toggle_schema",
            input: { schemaName: "billing", enabled: true },
          },
          { capability: "toggle_schema", input: { schemaName: "billing" } }, // no enabled → dropped
        ],
      }),
    );
    const caps = out.map((m) => m.capability);
    expect(caps).toEqual([
      "delete_schema_label",
      "upsert_schema_property",
      "toggle_schema",
    ]);
    const prop = out.find((m) => m.capability === "upsert_schema_property");
    expect(prop?.input.ownerKind).toBe("node"); // defaulted
    expect(prop?.input.dataType).toBe("string"); // normalized
    expect(prop?.input.required).toBe(false); // defaulted
  });

  it("returns [] for an empty response object", () => {
    expect(
      buildProposedMutations(resp({ assistantMessage: "nothing to do" })),
    ).toEqual([]);
  });
});
