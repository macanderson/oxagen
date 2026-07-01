/**
 * schema-drift.test.ts — Fails CI if `oxagenSettingsSchema` (the source of
 * truth in `apps/cli/src/settings/schema.ts`) changes without regenerating
 * the committed `public/oxagen-cli-settings-schema.json` artifact that
 * `schemas.oxagen.sh` serves.
 *
 * Regenerate with `pnpm --filter @oxagen/schemas run settings:schema`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  defaultSchemaOutPath,
  generateOxagenCliSettingsSchema,
  writeOxagenCliSettingsSchema,
} from "../scripts/generate.js";

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

describe("writeOxagenCliSettingsSchema", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oxagen-schemas-"));

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("writes the freshly generated schema (with trailing newline) to the given path", () => {
    const outPath = join(scratch, "settings-schema.json");
    const returned = writeOxagenCliSettingsSchema(outPath);

    expect(returned).toBe(outPath);
    const written = readFileSync(outPath, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(JSON.parse(written)).toStrictEqual(generateOxagenCliSettingsSchema());
  });

  it("defaults to the committed public artifact path and rewrites it idempotently", () => {
    const returned = writeOxagenCliSettingsSchema();

    expect(returned).toBe(defaultSchemaOutPath());
    expect(returned).toBe(committedPath);
    // The default write targets the committed file; it must stay in sync, so
    // the on-disk artifact after the rewrite equals a fresh generation.
    expect(JSON.parse(readFileSync(committedPath, "utf8"))).toStrictEqual(
      generateOxagenCliSettingsSchema(),
    );
  });
});
