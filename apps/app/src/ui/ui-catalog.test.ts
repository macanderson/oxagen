// Every enum value a primitive renders has its copy in messages/ui.json, so a
// new value in src/data/contracts cannot ship as a raw message key.
import { describe, expect, it } from "vitest";
import ui from "../../messages/ui.json";
import { CostBasis } from "@/data/contracts/common";

const catalog = ui.ui as unknown as Record<
  string,
  Record<string, { label?: unknown; description?: unknown }>
>;

const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["basis", CostBasis.options],
];

describe("messages/ui.json", () => {
  it.each(cases)(
    "has a label and description for every %s value",
    (namespace, values) => {
      for (const value of values) {
        const entry = catalog[namespace]?.[value];
        expect(entry, `${namespace}.${value}`).toBeDefined();
        expect(typeof entry?.label, `${namespace}.${value}.label`).toBe(
          "string",
        );
        expect(
          typeof entry?.description,
          `${namespace}.${value}.description`,
        ).toBe("string");
      }
    },
  );
});
