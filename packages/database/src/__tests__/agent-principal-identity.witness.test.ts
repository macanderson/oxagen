import { expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agents } from "../schema/index";

it("requires every agent identity to persist its IAM principal", () => {
  const principalId = getTableConfig(agents).columns.find(
    (column) => column.name === "principal_id",
  );

  expect(principalId, "agent.agents.principal_id must exist").toBeDefined();
  expect(principalId?.notNull).toBe(true);
});
