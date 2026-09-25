import { describe, expect, it } from "vitest";
import { areaLabelsFor } from "./ensure-manifest-tickets";

describe("areaLabelsFor", () => {
  it("labels a legacy dotted name by its domain prefix", () => {
    expect(areaLabelsFor("billing.checkout")).toEqual(["billing"]);
    expect(areaLabelsFor("org.member.remove")).toEqual(["iam", "foundations"]);
  });

  it("labels ADR-025 verb-first names by the nouns they carry", () => {
    expect(areaLabelsFor("create_checkout_session")).toEqual(["billing"]);
    expect(areaLabelsFor("list_invoices")).toEqual(["billing"]);
    expect(areaLabelsFor("remove_org_member")).toEqual(["iam", "foundations"]);
    expect(areaLabelsFor("list_members")).toEqual(["iam"]);
    expect(areaLabelsFor("list_iam_roles")).toEqual(["iam"]);
  });

  it("unions labels across nouns without repeats", () => {
    expect(areaLabelsFor("set_org_billing_terms")).toEqual([
      "iam",
      "foundations",
      "billing",
    ]);
  });

  it("gives no labels to a name with no mapped noun", () => {
    expect(areaLabelsFor("list_mandates")).toEqual([]);
    expect(areaLabelsFor("")).toEqual([]);
    expect(areaLabelsFor("get_constructor")).toEqual([]);
  });
});
