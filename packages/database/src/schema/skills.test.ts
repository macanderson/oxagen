import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { skillConfigVersions, skillResolutions } from "./skills";

describe("skill resolution evidence schema", () => {
  it.each([skillConfigVersions, skillResolutions])(
    "carries tenant scope without mutation timestamps",
    (table) => {
      const config = getTableConfig(table);
      expect(config.schema).toBe("skills");
      const names = config.columns.map((column) => column.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "id",
          "public_id",
          "org_id",
          "workspace_id",
          "created_at",
        ]),
      );
      expect(names).not.toContain("updated_at");
      expect(names).not.toContain("deleted_at");
    },
  );
  it("scopes the resolution's configuration foreign key to both tenant ids", () => {
    const ref = getTableConfig(skillResolutions).foreignKeys[0]!.reference();
    expect(ref.columns.map((column) => column.name)).toEqual([
      "org_id",
      "workspace_id",
      "config_version_id",
    ]);
    expect(ref.foreignColumns.map((column) => column.name)).toEqual([
      "org_id",
      "workspace_id",
      "id",
    ]);
  });
});
