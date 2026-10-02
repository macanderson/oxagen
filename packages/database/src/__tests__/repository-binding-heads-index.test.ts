/**
 * The trigger `repository_binding_heads_exclusive_main` reads every head for
 * one repository, in every workspace and of either role, on each head write
 * and while the writer holds that repository's advisory lock (#3340 finding
 * 4). Its lookup supplies the provider and the provider's repository id and
 * nothing else, so only a non-partial index that leads with those two columns
 * serves it. The unique index on the same columns is partial on the steering
 * role, and the other unique index leads with the connection.
 *
 * Operates on the Drizzle table definition through `getTableConfig`: no live
 * database.
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { repositoryBindingHeads } from "../schema/ingestion";

describe("repository_binding_heads indexes", () => {
  it("indexes every head of one repository for the trigger's cross-tenant lookup", () => {
    const { indexes } = getTableConfig(repositoryBindingHeads);
    const leading = (index: (typeof indexes)[number]) =>
      index.config.columns
        .slice(0, 2)
        .map((column) => ("name" in column ? column.name : null));
    const serving = indexes.filter(
      (index) =>
        index.config.where === undefined &&
        leading(index).join(",") === "provider,provider_repository_id",
    );
    expect(serving.map((index) => index.config.name)).toEqual([
      "repository_binding_heads_repository_idx",
    ]);
  });

  it("keeps the steering unique index partial, so it cannot serve the lookup (negative)", () => {
    const { indexes } = getTableConfig(repositoryBindingHeads);
    const unique = indexes.find(
      (index) =>
        index.config.name === "repository_binding_heads_main_repository_uq",
    );
    expect(unique?.config.where).toBeDefined();
  });
});
