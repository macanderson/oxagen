// triage-corrections.test.ts: a person's corrections stay in force across new
// triage decisions until the person clears them.
import { describe, expect, it } from "vitest";
import { recordedDecision } from "./fixtures/triage-fixtures";
import {
  TRIAGE_ESTIMATE_MAX_MINUTES,
  TRIAGE_LIST_MAX_ITEMS,
  TRIAGE_TEXT_MAX_CHARS,
  type TriageCorrection,
  TriageCorrectionError,
  checkCorrectionValue,
  correctionRows,
  effectiveTriage,
  isTriageCorrectionField,
} from "./triage-corrections";

const DANA = "11111111-1111-4111-8111-111111111111";
const LEE = "22222222-2222-4222-8222-222222222222";

describe("effectiveTriage", () => {
  it("shows the decision's suggestion when no person corrected it", () => {
    const decision = recordedDecision();
    const view = effectiveTriage(decision, "tri_01", []);

    expect(view.decision).toBe("tri_01");
    expect(view.priority).toEqual({ value: "P1", by: "oxagen", actor: null, at: null });
    expect(view.priorityReason).toBe(decision.priority.reason);
    expect(view.cites).toEqual(["aintel.work.priorities#2"]);
    expect(view.estimate_minutes.value).toBe(45);
    expect(view.labels.value).toEqual(["Bug"]);
    expect(view.claims.value).toEqual(["src/export/**"]);
    expect(view.criteria.value).toEqual(decision.done_record?.criteria);
    expect(view.related).toEqual(["wi_01K5YV0B3N7PRA"]);
    expect(view.questions).toEqual([]);
  });

  it("shows nothing set when triage has not decided", () => {
    const view = effectiveTriage(null, "tri_ignored", []);
    expect(view.decision).toBeNull();
    expect(view.priority).toEqual({ value: null, by: null, actor: null, at: null });
    expect(view.priorityReason).toBeNull();
    expect(view.cites).toEqual([]);
    expect(view.criteria.value).toBeNull();
    expect(view.duplicates).toEqual([]);
  });

  it("applies a person's priority and drops triage's reason and cites", () => {
    const rows: TriageCorrection[] = [{ field: "priority", before: "P1", after: "P0", by: DANA, at: "2026-10-02T10:00:00.000Z" }];
    const view = effectiveTriage(recordedDecision(), "tri_01", rows);
    expect(view.priority).toEqual({ value: "P0", by: "person", actor: DANA, at: "2026-10-02T10:00:00.000Z" });
    expect(view.priorityReason).toBeNull();
    expect(view.cites).toEqual([]);
  });

  it("keeps a correction in force when a later decision suggests another value", () => {
    const rows: TriageCorrection[] = [{ field: "estimate_minutes", before: 45, after: 90, by: DANA, at: "2026-10-02T10:00:00.000Z" }];
    const later = { ...recordedDecision(), estimate_minutes: 30 };
    expect(effectiveTriage(later, "tri_02", rows).estimate_minutes).toEqual({
      value: 90,
      by: "person",
      actor: DANA,
      at: "2026-10-02T10:00:00.000Z",
    });
  });

  it("goes back to the suggestion once the person clears the correction, whatever order the rows come in", () => {
    const set: TriageCorrection = { field: "labels", before: ["Bug"], after: ["Bug", "Billing"], by: DANA, at: "2026-10-02T10:00:00.000Z" };
    const clear: TriageCorrection = { field: "labels", before: ["Bug", "Billing"], after: null, by: LEE, at: "2026-10-02T11:00:00.000Z" };
    expect(effectiveTriage(recordedDecision(), "tri_01", [set, clear]).labels).toEqual({ value: ["Bug"], by: "oxagen", actor: null, at: null });
    expect(effectiveTriage(recordedDecision(), "tri_01", [clear, set]).labels.value).toEqual(["Bug"]);
  });

  it("takes the later of two corrections on one field, and the later row on a tie", () => {
    const first: TriageCorrection = { field: "claims", before: null, after: ["a/**"], by: DANA, at: "2026-10-02T10:00:00.000Z" };
    const second: TriageCorrection = { field: "claims", before: ["a/**"], after: ["b/**"], by: LEE, at: "2026-10-02T10:00:00.000Z" };
    expect(effectiveTriage(recordedDecision(), "tri_01", [first, second]).claims.value).toEqual(["b/**"]);
  });

  it("shows a null criteria suggestion for an out of scope decision", () => {
    const outOfScope = { ...recordedDecision(), state: "out_of_scope" as const, workflow: null, done_record: null };
    expect(effectiveTriage(outOfScope, "tri_03", []).criteria.value).toBeNull();
  });
});

describe("correctionRows", () => {
  const view = effectiveTriage(recordedDecision(), "tri_01", []);
  const AT = "2026-10-02T12:00:00.000Z";

  it("writes one row per changed field, against the view the person read", () => {
    const rows = correctionRows(view, { priority: "P2", estimate_minutes: 120, labels: ["Bug", " Billing "] }, DANA, AT);
    expect(rows).toEqual([
      { field: "priority", before: "P1", after: "P2", by: DANA, at: AT },
      { field: "estimate_minutes", before: 45, after: 120, by: DANA, at: AT },
      { field: "labels", before: ["Bug"], after: ["Bug", "Billing"], by: DANA, at: AT },
    ]);
  });

  it("writes nothing for a value the view already shows", () => {
    expect(correctionRows(view, { priority: "P1", labels: ["Bug"] }, DANA, AT)).toEqual([]);
  });

  it("clears only a field a person corrected", () => {
    expect(correctionRows(view, { priority: null }, DANA, AT)).toEqual([]);
    const corrected = effectiveTriage(recordedDecision(), "tri_01", [
      { field: "priority", before: "P1", after: "P0", by: LEE, at: "2026-10-02T09:00:00.000Z" },
    ]);
    expect(correctionRows(corrected, { priority: null }, DANA, AT)).toEqual([
      { field: "priority", before: "P0", after: null, by: DANA, at: AT },
    ]);
  });

  it("drops duplicate list entries and trims each one", () => {
    expect(correctionRows(view, { criteria: ["CI passes.", "CI passes. ", "A test fails first."] }, DANA, AT)[0]?.after).toEqual([
      "CI passes.",
      "A test fails first.",
    ]);
  });
});

describe("checkCorrectionValue", () => {
  it("refuses values outside each field's range", () => {
    expect(() => checkCorrectionValue("priority", "P4")).toThrow(TriageCorrectionError);
    expect(() => checkCorrectionValue("estimate_minutes", -1)).toThrow("whole number of minutes");
    expect(() => checkCorrectionValue("estimate_minutes", 1.5)).toThrow(TriageCorrectionError);
    expect(() => checkCorrectionValue("estimate_minutes", TRIAGE_ESTIMATE_MAX_MINUTES + 1)).toThrow(TriageCorrectionError);
    expect(() => checkCorrectionValue("labels", "Bug")).toThrow("must be a list of text");
    expect(() => checkCorrectionValue("labels", [""])).toThrow("non-empty text");
    expect(() => checkCorrectionValue("labels", [3])).toThrow("non-empty text");
    expect(() => checkCorrectionValue("claims", Array.from({ length: TRIAGE_LIST_MAX_ITEMS + 1 }, (_, i) => `p${i}/**`))).toThrow(
      `The most is ${TRIAGE_LIST_MAX_ITEMS}`,
    );
    expect(() => checkCorrectionValue("claims", ["x".repeat(TRIAGE_TEXT_MAX_CHARS + 1)])).toThrow("longer than");
    expect(() => checkCorrectionValue("criteria", [])).toThrow("at least one acceptance criterion");
  });

  it("accepts each field's valid values", () => {
    expect(checkCorrectionValue("priority", "P0")).toBe("P0");
    expect(checkCorrectionValue("estimate_minutes", 0)).toBe(0);
    expect(checkCorrectionValue("claims", [])).toEqual([]);
    expect(new TriageCorrectionError("x").code).toBe("triage_correction_invalid");
  });

  it("names the correctable fields", () => {
    expect(isTriageCorrectionField("priority")).toBe(true);
    expect(isTriageCorrectionField("state")).toBe(false);
  });
});
