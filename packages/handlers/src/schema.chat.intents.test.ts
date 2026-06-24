import { describe, it, expect } from "vitest";
import { detectSimpleIntents } from "./schema.chat";

const SCHEMAS = [
  { name: "support", labels: ["SupportTicket", "Bug"], rels: [] },
  { name: "subscription", labels: ["Subscription", "Plan"], rels: [] },
  { name: "billing", labels: ["Invoice", "Payment"], rels: [] },
];

describe("detectSimpleIntents — deterministic schema-edit parsing", () => {
  it("drops a schema (drop/delete/remove + name, plural-tolerant)", () => {
    for (const msg of ["drop the support schema entirely", "delete the support schema", "remove the supports schema"]) {
      expect(detectSimpleIntents(msg, SCHEMAS)).toEqual([
        { capability: "schema.delete", input: { schemaName: "support" } },
      ]);
    }
  });

  it("disables / enables a schema", () => {
    expect(detectSimpleIntents("disable the billing schema", SCHEMAS)).toEqual([
      { capability: "schema.toggle", input: { schemaName: "billing", enabled: false } },
    ]);
    expect(detectSimpleIntents("deactivate subscription", SCHEMAS)).toEqual([
      { capability: "schema.toggle", input: { schemaName: "subscription", enabled: false } },
    ]);
    expect(detectSimpleIntents("enable the billing schema", SCHEMAS)).toEqual([
      { capability: "schema.toggle", input: { schemaName: "billing", enabled: true } },
    ]);
    expect(detectSimpleIntents("turn on subscription", SCHEMAS)).toEqual([
      { capability: "schema.toggle", input: { schemaName: "subscription", enabled: true } },
    ]);
  });

  it("adds properties to a schema, inferring dataType and the matching label", () => {
    const out = detectSimpleIntents(
      "add a number_of_licenses field and a customer_since field to the subscriptions schema",
      SCHEMAS,
    );
    expect(out).toEqual([
      {
        capability: "schema.property.upsert",
        input: { schemaName: "subscription", ownerKind: "node", ownerName: "Subscription", key: "number_of_licenses", dataType: "integer", required: false },
      },
      {
        capability: "schema.property.upsert",
        input: { schemaName: "subscription", ownerKind: "node", ownerName: "Subscription", key: "customer_since", dataType: "date", required: false },
      },
    ]);
  });

  it("returns [] for create/open-ended asks (LLM path handles those)", () => {
    expect(detectSimpleIntents("generate the schemas for a b2b saas company", SCHEMAS)).toEqual([]);
    expect(detectSimpleIntents("what schemas do I have?", SCHEMAS)).toEqual([]);
  });

  it("returns [] when no real schema name is referenced (no false positives)", () => {
    expect(detectSimpleIntents("drop the marketing schema", SCHEMAS)).toEqual([]);
    expect(detectSimpleIntents("disable everything", SCHEMAS)).toEqual([]);
  });

  it("returns [] when the draft is empty", () => {
    expect(detectSimpleIntents("drop the support schema", [])).toEqual([]);
  });
});
