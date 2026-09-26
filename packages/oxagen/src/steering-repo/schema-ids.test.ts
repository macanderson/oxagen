import { describe, expect, it } from "vitest";
import {
  readSchemaDirective,
  SCHEMA_BASE_URL,
  SCHEMA_IDS,
  schemaDirective,
  schemaUrl,
  STEERING_REPO_SCHEMA_IDS,
} from "./schema-ids";

describe("schema ids", () => {
  it("lists every id in the order the spec gives", () => {
    expect([...SCHEMA_IDS]).toEqual([
      "steering-record/v1",
      "workspace/v1",
      "agent/v1",
      "governance/v1",
      "toolbelt/v1",
      "mcp-server/v1",
      "mcp-tools/v1",
      "mcp-tools-lock/v1",
      "tool-manifest/v1",
      "reflection/v1",
      "promotion/v1",
      "bundle/v1",
    ]);
  });

  it("lists no id twice", () => {
    expect(new Set(SCHEMA_IDS).size).toBe(SCHEMA_IDS.length);
  });

  it("keeps the steering repo ids a subset of the contract ids", () => {
    expect(STEERING_REPO_SCHEMA_IDS).toHaveLength(8);
    for (const id of STEERING_REPO_SCHEMA_IDS) {
      expect(SCHEMA_IDS).toContain(id);
    }
  });

  it("leaves the four MCP Studio ids out of the steering repo ids", () => {
    const steering: readonly string[] = STEERING_REPO_SCHEMA_IDS;
    for (const id of [
      "mcp-server/v1",
      "mcp-tools/v1",
      "mcp-tools-lock/v1",
      "tool-manifest/v1",
    ]) {
      expect(steering).not.toContain(id);
    }
  });
});

describe("schemaUrl and schemaDirective", () => {
  it("publishes every schema under the base URL", () => {
    expect(SCHEMA_BASE_URL).toBe("https://oxagen.sh/schemas/");
    expect(schemaUrl("agent/v1")).toBe(
      "https://oxagen.sh/schemas/agent/v1.json",
    );
  });

  it("writes the directive a TOML file opens with", () => {
    expect(schemaDirective("workspace/v1")).toBe(
      "#:schema https://oxagen.sh/schemas/workspace/v1.json",
    );
  });
});

describe("readSchemaDirective", () => {
  it.each([...SCHEMA_IDS])("reads back the directive for %s", (id) => {
    expect(readSchemaDirective(schemaDirective(id))).toBe(id);
    expect(readSchemaDirective(`${schemaDirective(id)}\nname = "x"\n`)).toBe(
      id,
    );
  });

  it.each([
    ["an empty file", ""],
    ["a file with no directive", 'name = "refunds"\n'],
    [
      "a directive on the second line",
      '\n#:schema https://oxagen.sh/schemas/agent/v1.json\n',
    ],
    ["a foreign URL", "#:schema https://example.com/schemas/agent/v1.json\n"],
    [
      "a directive with no space",
      "#:schemahttps://oxagen.sh/schemas/agent/v1.json\n",
    ],
    [
      "a URL that is not JSON",
      "#:schema https://oxagen.sh/schemas/agent/v1.toml\n",
    ],
    [
      "an id the contract does not have",
      "#:schema https://oxagen.sh/schemas/agent/v2.json\n",
    ],
    ["an empty id", "#:schema https://oxagen.sh/schemas/.json\n"],
    [
      "a first line that ends in a carriage return",
      "#:schema https://oxagen.sh/schemas/agent/v1.json\r\nname = \"x\"\r\n",
    ],
    [
      "trailing text after the URL",
      "#:schema https://oxagen.sh/schemas/agent/v1.json # agent\n",
    ],
  ])("returns null for %s", (_label, text) => {
    expect(readSchemaDirective(text)).toBeNull();
  });
});
