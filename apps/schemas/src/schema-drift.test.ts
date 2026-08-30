/**
 * schema-drift.test.ts — Fails if `oxagenSettingsSchema` (the source of truth
 * in `apps/cli/src/settings/schema.ts`) changes without regenerating the
 * committed `public/oxagen-cli-settings-schema.json` artifact that
 * `schemas.oxagen.sh` serves.
 *
 * Caveat: CI does not reliably reach this file. `@oxagen/schemas` declares no
 * dependency on `@oxagen/cli`, so a CLI-only PR does not mark this package
 * affected under `turbo --filter=...[origin/main]`, and Turborepo's task hash
 * excludes the CLI source, so a cached pass can be replayed. Run this test by
 * hand after editing the Zod schema. See the README.
 *
 * Regenerate with `pnpm --filter @oxagen/schemas run settings:schema`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const committed = JSON.parse(
      readFileSync(committedPath, "utf8"),
    ) as unknown;
    const fresh = generateOxagenCliSettingsSchema();

    expect(committed).toStrictEqual(fresh);
  });

  it("is served with the required $id, title, and description", () => {
    const fresh = generateOxagenCliSettingsSchema();

    expect(fresh.$id).toBe(
      "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json",
    );
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
    expect(JSON.parse(written)).toStrictEqual(
      generateOxagenCliSettingsSchema(),
    );
  });

  // Exercises the no-argument overload, which targets the committed artifact.
  // The original bytes are captured first and restored in `finally`: letting
  // this write stand would silently repair any drift the first test just
  // detected, so a second `vitest run` would pass and the gate would be gone.
  // Restoring verbatim also keeps the working tree clean after a test run.
  //
  // HAZARD: this is the one test that touches a git-tracked file, and
  // read-then-restore is not atomic. `pnpm gate` runs `test:unit` and
  // `test:coverage` as sibling turbo tasks with no ordering between them, so
  // two processes can execute this test at once and one can capture a
  // half-written `original`. The damage is bounded (the file is tracked; `git
  // checkout` restores it) but the fix is to stop writing to the real path —
  // stub `writeFileSync` and assert only the path the default argument
  // resolves to.
  it("defaults to the committed public artifact path", () => {
    const original = readFileSync(committedPath, "utf8");
    try {
      const returned = writeOxagenCliSettingsSchema();

      expect(returned).toBe(defaultSchemaOutPath());
      expect(returned).toBe(committedPath);
    } finally {
      writeFileSync(committedPath, original, "utf8");
    }
  });
});
