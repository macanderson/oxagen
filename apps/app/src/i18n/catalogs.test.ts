import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { catalogStems, mergeCatalogs, parseCatalog } from "./catalogs";

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
    expect(run).toThrow(
      expect.objectContaining({ code: "i18n_catalog_invalid" }),
    );
    expect(run).toThrow("messages/en.json: the shared catalog is missing");
  });

  it.each([
    "Fleet.json",
    "api_keys.json",
    "fleet page.json",
    ".json",
    "-x.json",
  ])("refuses %s, a name that is not a kebab-case stem", (entry) => {
    expect(() => catalogStems(["en.json", entry])).toThrow(
      expect.objectContaining({ code: "i18n_catalog_invalid" }),
    );
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
    expect(run).toThrow(
      expect.objectContaining({
        code: "i18n_duplicate_namespace",
        namespace: "states",
      }),
    );
    expect(run).toThrow(
      '"states" is declared by both messages/en.json and messages/fleet.json',
    );
  });
});

describe("messages/en.json", () => {
  it("is the shared catalog and carries the shared namespaces", () => {
    expect(catalogStems(["en.json"])).toEqual(["en"]);
    expect(Object.keys(en)).toEqual(
      expect.arrayContaining([
        "app",
        "pages",
        "unrecorded",
        "notFound",
        "globalError",
      ]),
    );
  });
});

/**
 * The dotted path of every key that one JSON object in `text` declares twice.
 * JSON.parse keeps the last copy without a word, so a merge that leaves two
 * copies of a key changes the shown sentence and nothing fails.
 */
function duplicateKeys(text: string): string[] {
  const duplicates: string[] = [];
  const stack: { keys: Set<string> | null; path: string }[] = [];
  let lastKey = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"')
        end += text[end] === "\\" ? 2 : 1;
      const raw = text.slice(i, end + 1);
      i = end;
      let next = end + 1;
      while (/\s/.test(text[next] ?? "")) next++;
      const top = stack.at(-1);
      if (text[next] === ":" && top?.keys) {
        const key: unknown = JSON.parse(raw);
        if (typeof key !== "string") continue;
        if (top.keys.has(key)) duplicates.push(`${top.path}${key}`);
        top.keys.add(key);
        lastKey = key;
      }
    } else if (ch === "{" || ch === "[") {
      const parent = stack.at(-1);
      const at = parent
        ? `${parent.path}${parent.keys ? lastKey : "[]"}.`
        : "";
      stack.push({ keys: ch === "{" ? new Set() : null, path: at });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    }
  }
  return duplicates;
}

describe("duplicateKeys", () => {
  it("names a key declared twice in one object", () => {
    expect(duplicateKeys('{"a":{"b":"x","c":"y","b":"z"}}')).toEqual(["a.b"]);
  });

  it("allows one key in two sibling objects", () => {
    expect(duplicateKeys('{"a":{"b":"x"},"c":{"b":"y"}}')).toEqual([]);
  });

  it("reads a quoted key inside a value as text", () => {
    expect(duplicateKeys('{"a":"say \\"b\\": no","b":"x"}')).toEqual([]);
  });
});

describe("the catalogs in messages/", () => {
  const dir = fileURLToPath(new URL("../../messages", import.meta.url));
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));

  it.each(files)("%s declares each key once per object", (file) => {
    expect(duplicateKeys(readFileSync(path.join(dir, file), "utf8"))).toEqual(
      [],
    );
  });
});
