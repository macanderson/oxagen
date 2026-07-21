import { expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agents } from "../schema/index";

it("enforces one agent identity per persistent IAM principal", () => {
  const principalIndex = getTableConfig(agents).indexes.find((index) =>
    index.config.columns.some(
      (column) =>
        typeof column === "object" &&
        column !== null &&
        "name" in column &&
        column.name === "principal_id",
    ),
  );

  expect(principalIndex?.config.unique).toBe(true);
});
