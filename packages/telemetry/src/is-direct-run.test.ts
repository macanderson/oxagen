import { describe, it, expect } from "vitest";
import { isDirectRunEntry } from "./is-direct-run";

describe("isDirectRunEntry", () => {
  it("is TRUE when node runs the script directly (.js/.ts/.mjs)", () => {
    expect(
      isDirectRunEntry(
        "file:///app/dist/migrate.js",
        "/app/dist/migrate.js",
        "migrate",
      ),
    ).toBe(true);
    expect(
      isDirectRunEntry("file:///src/migrate.ts", "/src/migrate.ts", "migrate"),
    ).toBe(true);
    expect(
      isDirectRunEntry(
        "file:///app/migrate.mjs",
        "/app/migrate.mjs",
        "migrate",
      ),
    ).toBe(true);
    expect(
      isDirectRunEntry("file:///app/seed.js", "/app/seed.js", "seed"),
    ).toBe(true);
    expect(isDirectRunEntry("file:///app/cli.js", "/app/cli.js", "cli")).toBe(
      true,
    );
  });

  it("is FALSE inside a single-file bundle (the boot-crash regression)", () => {
    // The bundler rewrites import.meta.url to the bundle path, which equals
    // argv[1] — so the bare equality would be TRUE. The basename check saves us:
    // the entry is oxagen.mjs, not migrate.*, so the self-run block stays dormant.
    expect(
      isDirectRunEntry("file:///app/oxagen.mjs", "/app/oxagen.mjs", "migrate"),
    ).toBe(false);
    expect(
      isDirectRunEntry("file:///app/oxagen.mjs", "/app/oxagen.mjs", "seed"),
    ).toBe(false);
    expect(
      isDirectRunEntry("file:///app/oxagen.mjs", "/app/oxagen.mjs", "cli"),
    ).toBe(false);
  });

  it("is FALSE when the module is merely imported (url != entry)", () => {
    expect(
      isDirectRunEntry(
        "file:///src/migrate.ts",
        "/app/other-entry.js",
        "migrate",
      ),
    ).toBe(false);
  });

  it("is FALSE when argv[1] is absent", () => {
    expect(
      isDirectRunEntry("file:///src/migrate.ts", undefined, "migrate"),
    ).toBe(false);
  });

  it("requires an EXACT basename match (no prefix/suffix bleed)", () => {
    expect(
      isDirectRunEntry(
        "file:///app/premigrate.js",
        "/app/premigrate.js",
        "migrate",
      ),
    ).toBe(false);
    expect(
      isDirectRunEntry(
        "file:///app/migrate-all.js",
        "/app/migrate-all.js",
        "migrate",
      ),
    ).toBe(false);
  });

  it("handles Windows-style backslash paths", () => {
    expect(
      isDirectRunEntry(
        "file://C:\\app\\migrate.js",
        "C:\\app\\migrate.js",
        "migrate",
      ),
    ).toBe(true);
  });
});
