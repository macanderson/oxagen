import { describe, it, expect } from "vitest";
import { sandboxTemplateManifestSchema } from "@oxagen/oxagen/contracts/sandbox-template-manifest";
import {
  MANIFEST_REFERENCE,
  MANIFEST_REFERENCE_KEYS,
} from "./manifest-reference";

describe("manifest-reference completeness", () => {
  it("documents exactly the manifest schema's top-level keys — no more, no less", () => {
    const schemaKeys = Object.keys(sandboxTemplateManifestSchema.shape).sort();
    expect(MANIFEST_REFERENCE_KEYS.slice().sort()).toEqual(schemaKeys);
  });

  it("gives every section at least one field entry with a non-empty description", () => {
    for (const section of MANIFEST_REFERENCE) {
      expect(section.fields.length).toBeGreaterThan(0);
      for (const field of section.fields) {
        expect(field.path.length).toBeGreaterThan(0);
        expect(field.type.length).toBeGreaterThan(0);
        expect(field.values.length).toBeGreaterThan(0);
        expect(field.description.length).toBeGreaterThan(0);
      }
    }
  });

  it("has no duplicate section keys or duplicate field paths", () => {
    const keys = MANIFEST_REFERENCE.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);

    const paths = MANIFEST_REFERENCE.flatMap((s) =>
      s.fields.map((f) => f.path),
    );
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("flags the declared-but-not-yet-provisionable network modes in provider notes", () => {
    const networkModeField = MANIFEST_REFERENCE.find(
      (s) => s.key === "network",
    )?.fields.find((f) => f.path === "network.mode");
    expect(networkModeField?.providerNotes).toMatch(/not yet provisionable/i);
  });
});
