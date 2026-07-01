/**
 * schema-drift.test.ts — Fails CI if `oxagenSettingsSchema` (the source of
 * truth in `apps/cli/src/settings/schema.ts`) changes without regenerating
 * the committed `public/oxagen-cli-settings-schema.json` artifact that
 * `schemas.oxagen.sh` serves.
 *
 * Regenerate with `pnpm --filter @oxagen/schemas run settings:schema`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateOxagenCliSettingsSchema } from "../scripts/generate.js";

const committedPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public/oxagen-cli-settings-schema.json",
);

describe("oxagen-cli-settings-schema.json drift", () => {
  it("matches the schema freshly generated from oxagenSettingsSchema", () => {
    const committed = JSON.parse(readFileSync(committedPath, "utf8")) as unknown;
    const fresh = generateOxagenCliSettingsSchema();

    expect(committed).toStrictEqual(fresh);
  });

  it("is served with the required $id, title, and description", () => {
    const fresh = generateOxagenCliSettingsSchema();

    expect(fresh.$id).toBe("https://schemas.oxagen.sh/oxagen-cli-settings-schema.json");
    expect(typeof fresh.title).toBe("string");
    expect(typeof fresh.description).toBe("string");
  });
});
