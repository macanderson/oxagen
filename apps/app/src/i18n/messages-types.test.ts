// The generator of src/i18n/messages.d.ts (INV-12): the checked-in file is
// what the catalogs produce, `--check` refuses a stale or missing file, and a
// catalog value that is neither a message nor a namespace is refused.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MESSAGES_TYPES_FILE,
  renderMessagesTypes,
  run,
} from "../../scripts/gen-messages-types";
import { APP_DIR } from "../test/arch/parse";

let dir: string;

function writeCatalog(messages: unknown) {
  writeFileSync(
    path.join(dir, "messages", "en.json"),
    JSON.stringify(messages),
  );
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "messages-types-"));
  mkdirSync(path.join(dir, "messages"));
  mkdirSync(path.join(dir, "src", "i18n"), { recursive: true });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("gen-messages-types", () => {
  it("the checked-in file is what messages/*.json generate", () => {
    expect(run(["--check"], APP_DIR)).toBe(0);
  });

  it("types every key, quoting one that is not an identifier", () => {
    writeCatalog({
      app: { name: "Oxagen", "api-keys": { title: "API keys" } },
    });
    expect(run([], dir)).toBe(0);
    const text = readFileSync(path.join(dir, MESSAGES_TYPES_FILE), "utf8");
    expect(text).toContain("    name: string;");
    expect(text).toContain('    "api-keys": {\n      title: string;');
    expect(text).toContain("Messages: Messages;");
    expect(run(["--check"], dir)).toBe(0);
  });

  it("fails the check when a catalog gained a key the file does not type (negative)", () => {
    writeCatalog({ app: { name: "Oxagen" } });
    run([], dir);
    writeCatalog({ app: { name: "Oxagen", tagline: "Workforce management" } });
    expect(run(["--check"], dir)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`${MESSAGES_TYPES_FILE} is stale`),
    );
  });

  it("fails the check when the file is missing (negative)", () => {
    writeCatalog({ app: { name: "Oxagen" } });
    expect(run(["--check"], dir)).toBe(1);
  });

  it("refuses a value that is neither a message nor a namespace (negative)", () => {
    expect(() => renderMessagesTypes({ app: { count: 3 } })).toThrow(
      "messages: app.count is neither a message string nor a namespace",
    );
  });
});
