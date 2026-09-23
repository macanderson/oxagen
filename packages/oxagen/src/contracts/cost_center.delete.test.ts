import { describe, expect, it } from "vitest";
import { costCenterDelete } from "./cost_center.delete";

describe("delete_cost_center contract", () => {
  it("takes one label and answers when it was deleted", () => {
    expect(costCenterDelete.mutates).toBe(true);
    expect(costCenterDelete.input.parse({ label: "ENG-1001" })).toEqual({
      label: "ENG-1001",
    });
    expect(costCenterDelete.input.safeParse({ label: "~none" }).success).toBe(
      false,
    );
    const out = { label: "ENG-1001", deletedAt: "2026-09-22T10:00:00.000Z" };
    expect(costCenterDelete.output.parse(out)).toEqual(out);
  });
});
