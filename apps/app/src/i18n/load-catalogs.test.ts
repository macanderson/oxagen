import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogError, DuplicateNamespaceError } from "./catalogs";
import { loadCatalogs } from "./load-catalogs";

let dir: string;

function write(name: string, body: unknown): void {
  writeFileSync(
    path.join(dir, name),
    typeof body === "string" ? body : JSON.stringify(body),
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "mc-messages-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadCatalogs", () => {
  it("discovers every catalog in the directory without a list naming them", () => {
    write("en.json", { app: { name: "Oxagen" } });
    write("fleet.json", { fleet: { title: "Fleet" } });
    write("spend.json", { spend: { title: "Spend" } });

    expect(loadCatalogs(dir)).toEqual({
      app: { name: "Oxagen" },
      fleet: { title: "Fleet" },
      spend: { title: "Spend" },
    });
  });

  it("skips subdirectories and files that are not JSON", () => {
    write("en.json", { app: {} });
    write("notes.md", "# not a catalog");
    mkdirSync(path.join(dir, "drafts.json"));
    mkdirSync(path.join(dir, "fr"));
    writeFileSync(path.join(dir, "fr", "en.json"), '{"nested":{}}');

    expect(loadCatalogs(dir)).toEqual({ app: {} });
  });

  it("refuses two catalogs that declare one namespace", () => {
    write("en.json", { states: {} });
    write("fleet.json", { states: {} });

    expect(() => loadCatalogs(dir)).toThrow(DuplicateNamespaceError);
  });

  it("refuses a directory without the shared catalog", () => {
    write("fleet.json", { fleet: {} });

    expect(() => loadCatalogs(dir)).toThrow(CatalogError);
  });

  it("names the catalog that is not valid JSON", () => {
    write("en.json", { app: {} });
    write("fleet.json", '{"fleet": ');

    expect(() => loadCatalogs(dir)).toThrow(/messages\/fleet\.json/);
  });
});
