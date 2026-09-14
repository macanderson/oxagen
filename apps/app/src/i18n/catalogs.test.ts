import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import {
  CatalogError,
  catalogStems,
  DuplicateNamespaceError,
  mergeCatalogs,
  parseCatalog,
  SHARED_CATALOG,
} from "./catalogs";

describe("catalogStems", () => {
  it("puts the shared catalog first and sorts the rest, whatever the listing order", () => {
    expect(
      catalogStems(["spend.json", "fleet.json", "en.json", "api-keys.json"]),
    ).toEqual(["en", "api-keys", "fleet", "spend"]);
  });

  it("ignores entries that are not JSON", () => {
    expect(catalogStems(["README.md", "en.json", ".DS_Store"])).toEqual(["en"]);
  });

  it("refuses a listing without the shared catalog", () => {
    const run = () => catalogStems(["fleet.json"]);
    expect(run).toThrow(CatalogError);
    expect(run).toThrow("messages/en.json: the shared catalog is missing");
  });

  it.each([
    "Fleet.json",
    "api_keys.json",
    "fleet page.json",
    ".json",
    "-x.json",
  ])("refuses %s, a name that is not a kebab-case stem", (entry) => {
    expect(() => catalogStems(["en.json", entry])).toThrow(CatalogError);
  });
});

describe("parseCatalog", () => {
  it("parses an object of namespaces", () => {
    expect(parseCatalog("fleet", '{"fleet":{"title":"Fleet"}}')).toEqual({
      fleet: { title: "Fleet" },
    });
  });

  it("names the file when the JSON is malformed", () => {
    expect(() => parseCatalog("fleet", '{"fleet":')).toThrow(
      /^messages\/fleet\.json: not valid JSON/,
    );
  });

  it.each(["[]", "null", '"fleet"', "3"])(
    "refuses %s, which is not an object of namespaces",
    (text) => {
      expect(() => parseCatalog("fleet", text)).toThrow(
        "messages/fleet.json: a catalog must be a JSON object of namespaces",
      );
    },
  );
});

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
  it("is the shared catalog and carries the shared namespaces", () => {
    expect(SHARED_CATALOG).toBe("en");
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
