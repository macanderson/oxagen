// A collector file reads into the fields work.collectors mirrors. A file that
// breaks the envelope, or a scope its registered module refuses, fails with
// every reason at once.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  COLLECTOR_FILE_DIR,
  type CollectorFile,
  type CollectorFileResult,
  WRITE_BACK_DEFAULTS,
  type WriteBackSwitches,
  collectorFileHash,
  collectorNameFromPath,
  isCollectorFilePath,
  readCollectorFile,
  readStoredWriteBack,
  resolveWriteBack,
} from "../file";
import { registerCollector, unregisterCollector } from "../registry";
import type { CollectorType } from "../types";
import { createFakeCollector } from "./fake";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../../../../work/fixtures/collectors");

/** The SHA-256 of zero bytes, a published constant. */
const EMPTY_SHA256 =
  "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const ALL_OFF: WriteBackSwitches = {
  certify_note: false,
  send_note: false,
  status: false,
  close: false,
  labels: false,
};

/** The top of a small Zendesk file at work/collectors/support.toml. */
const ZENDESK_HEAD = [
  'schema = "collector/v1"',
  'name = "support"',
  'label = "Support"',
  'type = "zendesk"',
];
const ZENDESK_PATH = "work/collectors/support.toml";
const CONNECTION = 'connection = "conn_1"';
const ZENDESK_SCOPE = ["[scope]", 'subdomain = "aintel"'];

afterEach(() => {
  unregisterCollector("zendesk");
});

function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, `${name}.toml`), "utf8");
}

function toml(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

function fileOf(result: CollectorFileResult): CollectorFile {
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.file;
}

function errorsOf(result: CollectorFileResult): string[] {
  if (result.ok) throw new Error(`${result.file.path} read without an error`);
  return result.errors;
}

/** Register the fake module as zendesk. Its scope is `{ project }` and nothing else. */
function registerFakeZendesk(): void {
  registerCollector(createFakeCollector({ type: "zendesk" }).definition);
}

describe("readCollectorFile on the spec's files", () => {
  it("reads the Zendesk file with its defaults and write-back table", () => {
    const text = fixture("support-zendesk");
    const file = fileOf(readCollectorFile("work/collectors/support-zendesk.toml", text));
    expect(file).toEqual({
      path: "work/collectors/support-zendesk.toml",
      name: "support-zendesk",
      label: "Support escalations",
      type: "zendesk",
      connection: "conn_01K5ZD7Q4R",
      scope: { subdomain: "aintel", views: ["Engineering escalations"] },
      defaults: { labels: ["Bug"], workflow: "fix-test-verify-review" },
      writeBack: {
        certify_note: true,
        send_note: true,
        status: false,
        close: false,
        labels: false,
      },
      fileHash: sha256(text),
    });
  });

  it("reads the Slack file with every write-back switch off", () => {
    const text = fixture("eng-requests");
    const file = fileOf(readCollectorFile("work/collectors/eng-requests.toml", text));
    expect(file).toEqual({
      path: "work/collectors/eng-requests.toml",
      name: "eng-requests",
      label: "#eng-requests",
      type: "slack",
      connection: "conn_01K5ZS2V8W",
      scope: { channel: "C07ENGREQ", trigger: "reaction", allow_bots: ["B05PAGERDUTY"] },
      defaults: { labels: [], workflow: null },
      writeBack: ALL_OFF,
      fileHash: sha256(text),
    });
  });

  it("reads the email file with no connection and every write-back switch off", () => {
    const text = fixture("inbox");
    const file = fileOf(readCollectorFile("work/collectors/inbox.toml", text));
    expect(file).toEqual({
      path: "work/collectors/inbox.toml",
      name: "inbox",
      label: "Engineering inbox",
      type: "email",
      connection: null,
      scope: {
        allow: ["@aintel.com", "ops@northwind.example"],
        forwarders: ["support@aintel.com"],
      },
      defaults: { labels: [], workflow: null },
      writeBack: ALL_OFF,
      fileHash: sha256(text),
    });
  });
});

describe("readCollectorFile failures", () => {
  it("reports text that is not TOML with the path", () => {
    const result = readCollectorFile("work/collectors/broken.toml", 'name = "broken');
    if (result.ok) throw new Error("the broken file read");
    expect(result.path).toBe("work/collectors/broken.toml");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^not valid TOML: /);
  });

  it("refuses a name that does not match the file name", () => {
    const result = readCollectorFile("work/collectors/other.toml", fixture("inbox"));
    expect(errorsOf(result)).toEqual(["name: inbox does not match the file name other"]);
  });

  it("refuses a collector that needs a connection and names none", () => {
    const types: CollectorType[] = ["zendesk", "slack", "github"];
    for (const type of types) {
      const text = toml(
        'schema = "collector/v1"',
        'name = "support"',
        'label = "Support"',
        `type = "${type}"`,
        ...ZENDESK_SCOPE,
      );
      expect(errorsOf(readCollectorFile(ZENDESK_PATH, text))).toEqual([
        `connection: a ${type} collector names its connection`,
      ]);
    }
  });

  it("refuses an email collector that names a connection", () => {
    const text = toml(
      'schema = "collector/v1"',
      'name = "inbox"',
      'label = "Inbox"',
      'type = "email"',
      CONNECTION,
      "[scope]",
      'allow = ["@aintel.com"]',
    );
    expect(errorsOf(readCollectorFile("work/collectors/inbox.toml", text))).toEqual([
      "connection: a email collector has no connection",
    ]);
  });

  it("refuses a write_back table on a Slack or an email collector", () => {
    const slack = toml(
      'schema = "collector/v1"',
      'name = "eng"',
      'label = "Eng"',
      'type = "slack"',
      'connection = "conn_2"',
      "[scope]",
      'channel = "C1"',
      "[write_back]",
      "certify_note = true",
    );
    expect(errorsOf(readCollectorFile("work/collectors/eng.toml", slack))).toEqual([
      "write_back: a slack collector has no write-back",
    ]);
    const email = toml(
      'schema = "collector/v1"',
      'name = "inbox"',
      'label = "Inbox"',
      'type = "email"',
      "[scope]",
      "[write_back]",
      "send_note = false",
    );
    expect(errorsOf(readCollectorFile("work/collectors/inbox.toml", email))).toEqual([
      "write_back: a email collector has no write-back",
    ]);
  });

  it("refuses an unknown top-level key", () => {
    const text = toml(...ZENDESK_HEAD, CONNECTION, 'owner = "ops"', ...ZENDESK_SCOPE);
    expect(errorsOf(readCollectorFile(ZENDESK_PATH, text))).toEqual([
      "Unrecognized key(s) in object: 'owner'",
    ]);
  });

  it("reports an unknown key and a missing connection together", () => {
    const text = toml(...ZENDESK_HEAD, 'owner = "ops"', ...ZENDESK_SCOPE);
    expect(errorsOf(readCollectorFile(ZENDESK_PATH, text))).toEqual([
      "Unrecognized key(s) in object: 'owner'",
      "connection: a zendesk collector names its connection",
    ]);
  });

  it("refuses unknown keys inside the defaults and write_back tables", () => {
    const text = toml(
      ...ZENDESK_HEAD,
      CONNECTION,
      ...ZENDESK_SCOPE,
      "[defaults]",
      'owner = "ops"',
      "[write_back]",
      "notify = true",
    );
    expect(errorsOf(readCollectorFile(ZENDESK_PATH, text))).toEqual([
      "defaults: Unrecognized key(s) in object: 'owner'",
      "write_back: Unrecognized key(s) in object: 'notify'",
    ]);
  });

  it("refuses a wrong schema id, a name that is not a slug, and an unknown type", () => {
    const schema = toml(
      'schema = "collector/v2"',
      'name = "support"',
      'label = "Support"',
      'type = "zendesk"',
      CONNECTION,
      ...ZENDESK_SCOPE,
    );
    expect(errorsOf(readCollectorFile(ZENDESK_PATH, schema))).toEqual([
      'schema: Invalid literal value, expected "collector/v1"',
    ]);

    const name = toml(
      'schema = "collector/v1"',
      'name = "Support_Desk"',
      'label = "Support"',
      'type = "zendesk"',
      CONNECTION,
      ...ZENDESK_SCOPE,
    );
    expect(errorsOf(readCollectorFile("work/collectors/Support_Desk.toml", name))).toEqual([
      "name: use lowercase words joined by single hyphens",
    ]);

    const type = toml(
      'schema = "collector/v1"',
      'name = "support"',
      'label = "Support"',
      'type = "trello"',
      CONNECTION,
      ...ZENDESK_SCOPE,
    );
    expect(errorsOf(readCollectorFile(ZENDESK_PATH, type))).toEqual([
      "type: Invalid enum value. Expected 'github' | 'jira' | 'linear' | 'zendesk' | 'servicenow' | 'salesforce' | 'slack' | 'email', received 'trello'",
    ]);
  });

  it("refuses a default label listed twice", () => {
    const text = toml(
      ...ZENDESK_HEAD,
      CONNECTION,
      ...ZENDESK_SCOPE,
      "[defaults]",
      'labels = ["Bug", "Bug"]',
    );
    expect(errorsOf(readCollectorFile(ZENDESK_PATH, text))).toEqual([
      "defaults.labels: list each value once",
    ]);
  });
});

describe("readCollectorFile with the type's module registered", () => {
  it("refuses a scope the module's config rejects", () => {
    registerFakeZendesk();
    const result = readCollectorFile(
      "work/collectors/support-zendesk.toml",
      fixture("support-zendesk"),
    );
    expect(errorsOf(result)).toEqual([
      "scope.project: Required",
      "scope: Unrecognized key(s) in object: 'subdomain', 'views'",
    ]);
  });

  it("reads a scope the module's config accepts", () => {
    registerFakeZendesk();
    const text = toml(...ZENDESK_HEAD, CONNECTION, "[scope]", 'project = "core"');
    const file = fileOf(readCollectorFile(ZENDESK_PATH, text));
    expect(file.scope).toEqual({ project: "core" });
    expect(file.name).toBe("support");
  });

  it("reports a name that does not match and a refused scope together", () => {
    registerFakeZendesk();
    const result = readCollectorFile("work/collectors/renamed.toml", fixture("support-zendesk"));
    expect(errorsOf(result)).toEqual([
      "name: support-zendesk does not match the file name renamed",
      "scope.project: Required",
      "scope: Unrecognized key(s) in object: 'subdomain', 'views'",
    ]);
  });

  it("leaves the scope unchecked once the module is removed", () => {
    registerFakeZendesk();
    unregisterCollector("zendesk");
    const result = readCollectorFile(
      "work/collectors/support-zendesk.toml",
      fixture("support-zendesk"),
    );
    expect(result.ok).toBe(true);
  });
});

describe("isCollectorFilePath and collectorNameFromPath", () => {
  it("accepts a .toml file directly in work/collectors", () => {
    expect(COLLECTOR_FILE_DIR).toBe("work/collectors");
    for (const path of ["work/collectors/inbox.toml", "work/collectors/support-zendesk.toml"])
      expect(isCollectorFilePath(path)).toBe(true);
  });

  it("refuses nested paths, other directories, and other extensions", () => {
    for (const path of [
      "work/collectors/nested/inbox.toml",
      "work/other/inbox.toml",
      "other/work/collectors/inbox.toml",
      "work/collectors.toml",
      "work/collectors/inbox.yaml",
      "work/collectors/inbox.toml.bak",
      "work/collectors/",
      "inbox.toml",
    ])
      expect(isCollectorFilePath(path)).toBe(false);
  });

  it("accepts a file named only .toml, whose collector name reads as empty", () => {
    // This pins a wart. Such a file always fails to read, because no slug is
    // empty, so the mirror reports it as invalid.
    expect(isCollectorFilePath("work/collectors/.toml")).toBe(true);
    expect(collectorNameFromPath("work/collectors/.toml")).toBe("");
  });

  it("names a collector by its file name without .toml", () => {
    expect(collectorNameFromPath("work/collectors/support-zendesk.toml")).toBe("support-zendesk");
    expect(collectorNameFromPath("inbox.toml")).toBe("inbox");
    expect(collectorNameFromPath("a/b/c.toml")).toBe("c");
    expect(collectorNameFromPath("work/collectors/README.md")).toBe("README.md");
  });
});

describe("collectorFileHash", () => {
  it("hashes the text as sha256 and 64 lowercase hex digits", () => {
    expect(collectorFileHash("")).toBe(EMPTY_SHA256);
    const text = fixture("support-zendesk");
    expect(collectorFileHash(text)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(collectorFileHash(text)).toBe(sha256(text));
  });

  it("gives the same hash for the same text and a new hash for any change", () => {
    const text = fixture("inbox");
    const hash = collectorFileHash(text);
    expect(collectorFileHash(text)).toBe(hash);
    expect(collectorFileHash(`${text} `)).not.toBe(hash);
    expect(collectorFileHash(text.replace("inbox", "inbox2"))).not.toBe(hash);
  });

  it("hashes the text as UTF-8", () => {
    expect(collectorFileHash("café")).toBe(sha256("café"));
  });
});

describe("resolveWriteBack", () => {
  it("turns every switch off for Slack and email, whatever the table says", () => {
    expect(resolveWriteBack("slack", { certify_note: true, close: true })).toEqual(ALL_OFF);
    expect(resolveWriteBack("email", undefined)).toEqual(ALL_OFF);
  });

  it("fills in the defaults for a type with write-back and no table", () => {
    const switches = resolveWriteBack("zendesk", undefined);
    expect(switches).toEqual({
      certify_note: true,
      send_note: true,
      status: false,
      close: false,
      labels: false,
    });
    expect(switches).toEqual({ ...WRITE_BACK_DEFAULTS });
    expect(switches).not.toBe(WRITE_BACK_DEFAULTS);
    expect(Object.isFrozen(switches)).toBe(false);
  });

  it("lets a partial table override only the switches it names", () => {
    expect(resolveWriteBack("github", { send_note: false, status: true })).toEqual({
      certify_note: true,
      send_note: false,
      status: true,
      close: false,
      labels: false,
    });
  });

  it("reads a partial [write_back] table from a file over the defaults", () => {
    const text = toml(...ZENDESK_HEAD, CONNECTION, ...ZENDESK_SCOPE, "[write_back]", "close = true");
    expect(fileOf(readCollectorFile(ZENDESK_PATH, text)).writeBack).toEqual({
      certify_note: true,
      send_note: true,
      status: false,
      close: true,
      labels: false,
    });
  });
});

describe("readStoredWriteBack", () => {
  it("reads the switches a row stores as true, and every other switch as off", () => {
    expect(readStoredWriteBack("github", { ...ALL_OFF, send_note: true })).toEqual({ ...ALL_OFF, send_note: true });
  });

  it("reads a missing or malformed column as all off, never as the file's defaults (negative)", () => {
    for (const stored of [null, undefined, {}, [], "send_note", { send_note: "true", certify_note: 1 }])
      expect(readStoredWriteBack("github", stored)).toEqual(ALL_OFF);
  });

  it("reads every switch off for a type with no write-back", () => {
    const on = { certify_note: true, send_note: true, status: true, close: true, labels: true };
    expect(readStoredWriteBack("slack", on)).toEqual(ALL_OFF);
  });
});
