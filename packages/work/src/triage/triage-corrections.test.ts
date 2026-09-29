import { describe, expect, it } from "vitest";
import { recordedDecision } from "./fixtures/triage-fixtures";
import { TRIAGE_CORRECTION_FIELDS, triageCorrections } from "./triage-corrections";

describe("triageCorrections", () => {
  it("writes nothing when nothing changed", () => {
    expect(triageCorrections(recordedDecision(), recordedDecision())).toEqual([]);
  });

  it("writes one row per changed field", () => {
    const before = recordedDecision();
    const after = recordedDecision();
    after.priority.label = "P0";
    after.priority.reason = "A person raised it to P0.";
    after.estimate_minutes = 90;
    after.workflow = "fix-validate-document-review";
    expect(triageCorrections(before, after)).toEqual([
      { field: "priority", before: "P1", after: "P0" },
      { field: "estimate_minutes", before: 45, after: 90 },
      { field: "workflow", before: "fix-test-verify-review", after: "fix-validate-document-review" },
    ]);
  });

  it("writes one row per label, duplicate, and claim removed or added", () => {
    const before = recordedDecision();
    const after = recordedDecision();
    after.labels = ["Regression", "Billing"];
    after.duplicates = ["wi_01K5YV0B3N7PRA"];
    after.claims = [];
    expect(triageCorrections(before, after)).toEqual([
      { field: "label", before: "Bug", after: null },
      { field: "label", before: null, after: "Regression" },
      { field: "label", before: null, after: "Billing" },
      { field: "duplicate", before: null, after: "wi_01K5YV0B3N7PRA" },
      { field: "claim", before: "src/export/**", after: null },
    ]);
  });

  it("pairs an edited criterion into one row, and writes removals and additions alone", () => {
    const before = recordedDecision();
    const edited = recordedDecision();
    edited.done_record = {
      criteria: [
        "A test fails before the change and passes after it.",
        "CI passes on the pull request.",
        "Exporting an invoice with a credit note returns a CSV file.",
      ],
    };
    expect(triageCorrections(before, edited)).toEqual([
      {
        field: "criterion",
        before: "Exporting an invoice with a credit note returns a CSV file instead of an error.",
        after: "Exporting an invoice with a credit note returns a CSV file.",
      },
    ]);

    const added = recordedDecision();
    added.done_record = { criteria: [...(before.done_record?.criteria ?? []), "The export log names the invoice."] };
    expect(triageCorrections(before, added)).toEqual([
      { field: "criterion", before: null, after: "The export log names the invoice." },
    ]);
    expect(triageCorrections(added, before)).toEqual([
      { field: "criterion", before: "The export log names the invoice.", after: null },
    ]);
  });

  it("counts a repeated criterion once per copy", () => {
    const before = recordedDecision();
    const after = recordedDecision();
    before.done_record = { criteria: ["CI passes.", "CI passes."] };
    after.done_record = { criteria: ["CI passes."] };
    expect(triageCorrections(before, after)).toEqual([{ field: "criterion", before: "CI passes.", after: null }]);
  });

  it("writes the state and every dropped criterion when a person marks the item out of scope", () => {
    const before = recordedDecision();
    const after = { ...recordedDecision(), state: "out_of_scope" as const, workflow: null, done_record: null };
    const rows = triageCorrections(before, after);
    expect(rows.map((row) => row.field)).toEqual(["state", "workflow", "criterion", "criterion", "criterion"]);
    expect(rows[0]).toEqual({ field: "state", before: "triaged", after: "out_of_scope" });
    expect(rows.slice(2).every((row) => row.after === null)).toBe(true);
  });

  it("names only fields in TRIAGE_CORRECTION_FIELDS", () => {
    const before = recordedDecision();
    const after = { ...recordedDecision(), state: "duplicate" as const, workflow: null, done_record: null };
    after.priority = { ...after.priority, label: "P3" };
    after.labels = ["Duplicate"];
    after.duplicates = ["wi_01K5YV0B3N7PRA"];
    after.claims = ["src/**"];
    after.estimate_minutes = 0;
    const fields = new Set(triageCorrections(before, after).map((row) => row.field));
    expect([...fields].sort()).toEqual([...TRIAGE_CORRECTION_FIELDS].sort());
  });
});
