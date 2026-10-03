// The three budget inputs of Edit workspace, read into the patch
// `update_workspace_settings` takes (#5426). What a blank input means depends
// on what was stored, and each case is asserted here rather than left to
// reading: a cleared limit is sent as null, an untouched blank or an
// unchanged number is not sent, and a bad value is refused on its own field
// before any write.
import { describe, expect, it } from "vitest";
import { budgetPatchOf } from "./workspace-budget-form";

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

const NO_LIMITS = { runEnrichment: null, assistant: null, work: null };

describe("budgetPatchOf", () => {
  it("sends a typed number as a number, with cents", () => {
    expect(
      budgetPatchOf(form({ budgetRunEnrichment: "2.50" }), NO_LIMITS),
    ).toEqual({ ok: true, patch: { runEnrichment: 2.5 } });
  });

  it("sends 0 as 0, which switches the lane off", () => {
    expect(budgetPatchOf(form({ budgetWork: "0" }), NO_LIMITS)).toEqual({
      ok: true,
      patch: { work: 0 },
    });
  });

  it("sends null for a blank whose stored value was a number: the limit goes", () => {
    expect(
      budgetPatchOf(form({ budgetAssistant: "" }), {
        ...NO_LIMITS,
        assistant: 12,
      }),
    ).toEqual({ ok: true, patch: { assistant: null } });
  });

  it("leaves out a blank whose stored value was null: nothing changed", () => {
    expect(budgetPatchOf(form({ budgetAssistant: " " }), NO_LIMITS)).toEqual({
      ok: true,
      patch: {},
    });
  });

  it("leaves out a number equal to the stored limit: the input as it opened", () => {
    expect(
      budgetPatchOf(
        form({ budgetRunEnrichment: "2.50", budgetAssistant: "", budgetWork: "0" }),
        { runEnrichment: 2.5, assistant: null, work: 0 },
      ),
    ).toEqual({ ok: true, patch: {} });
  });

  it("sends a number that differs from the stored limit", () => {
    expect(
      budgetPatchOf(form({ budgetWork: "4" }), { ...NO_LIMITS, work: 0 }),
    ).toEqual({ ok: true, patch: { work: 4 } });
  });

  it("leaves out every blank when the settings could not be read, so the write sends only what was typed", () => {
    expect(
      budgetPatchOf(form({ budgetRunEnrichment: "", budgetWork: "5" }), null),
    ).toEqual({ ok: true, patch: { work: 5 } });
  });

  it("reads a field the form does not carry as blank", () => {
    expect(budgetPatchOf(form({}), { ...NO_LIMITS, work: 3 })).toEqual({
      ok: true,
      patch: { work: null },
    });
  });

  it("refuses a negative value on its own field, before any write (negative)", () => {
    expect(budgetPatchOf(form({ budgetWork: "-1" }), NO_LIMITS)).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "budgetWork",
    });
  });

  it.each(["abc", "1e400", "NaN"])(
    "refuses %o, which is not a dollar amount (negative)",
    (typed) => {
      expect(
        budgetPatchOf(form({ budgetAssistant: typed }), NO_LIMITS),
      ).toMatchObject({ ok: false, field: "budgetAssistant" });
    },
  );
});
