/**
 * The model-credential provider list is written in THREE places, and this
 * suite is what keeps them the same list.
 *
 *   1. The contract enum (`@oxagen/oxagen`) — what every surface accepts.
 *   2. `MODEL_CREDENTIAL_PROVIDERS` (`@oxagen/database`) — what the resolver
 *      and the view mapper believe the column can hold. It cannot import (1):
 *      the database package sits below the contracts package in the graph.
 *   3. The `model_credentials_provider_check` CHECK — what Postgres admits.
 *
 * Each drift fails differently, and none of them loudly. A provider in (1) but
 * not (3) passes validation and is refused by Postgres as a 500 on save. One in
 * (3) but not (1) can be stored by a direct write and then breaks every read,
 * because `toCredentialView` parses the column against the enum. One missing
 * from (2) types as impossible downstream while being perfectly real.
 *
 * It lives in `@oxagen/ai` because this is the one package that depends on
 * both (1) and (2), and the SQL is read off disk.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_CREDENTIAL_PROVIDERS } from "@oxagen/database/model-credential-shape";
import { modelCredentialProviderSchema } from "@oxagen/oxagen/contracts/org.model_credential.shared";

const MIGRATIONS = join(__dirname, "../../database/atlas/migrations");

/** The provider list in the most recent migration that (re)defines the CHECK. */
function sqlProviderCheck(): string[] {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let latest: string[] | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const m =
      /model_credentials_provider_check[\s\S]*?"?provider"?\s+IN\s*\(([^)]*)\)/i.exec(
        sql,
      );
    if (m?.[1]) {
      latest = m[1]
        .split(",")
        .map((v) => v.trim().replace(/^'|'$/g, ""))
        .filter(Boolean);
    }
  }
  if (!latest)
    throw new Error("no migration defines model_credentials_provider_check");
  return latest;
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("model-credential provider lists", () => {
  const contract = modelCredentialProviderSchema.options;

  it("the database package's list is the contract's list", () => {
    expect(sorted(MODEL_CREDENTIAL_PROVIDERS)).toEqual(sorted(contract));
  });

  it("the Postgres CHECK admits exactly the contract's list", () => {
    expect(sorted(sqlProviderCheck())).toEqual(sorted(contract));
  });
});
