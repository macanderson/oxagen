import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import {
  CATALOG_FILES,
  DuplicateNamespaceError,
  mergeCatalogs,
} from "./catalogs";

describe("mergeCatalogs", () => {
  it("merges namespaces from every catalog", () => {
    expect(
      mergeCatalogs([
        ["en", { app: { name: "Oxagen" } }],
        ["fleet", { fleet: { title: "Fleet" } }],
      ]),
    ).toEqual({
      app: { name: "Oxagen" },
      fleet: { title: "Fleet" },
    });
  });

  it("throws when two catalogs claim one namespace", () => {
    const run = () =>
      mergeCatalogs([
        ["en", { states: {} }],
        ["fleet", { states: {} }],
      ]);
    expect(run).toThrow(DuplicateNamespaceError);
    expect(run).toThrow(
      '"states" is declared by both messages/en.json and messages/fleet.json',
    );
  });
});

describe("messages/en.json", () => {
  it("is the first catalog and carries the shared namespaces", () => {
    expect(CATALOG_FILES[0]).toBe("en");
    expect(Object.keys(en)).toEqual(
      expect.arrayContaining([
        "app",
        "routes",
        "states",
        "notFound",
        "globalError",
      ]),
    );
  });
});
