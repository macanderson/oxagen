// The mirror plans the writes that make work.collectors match the steering
// repo's collector files. It makes none of them.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectorFileHash } from "../file";
import type { CollectorHealth } from "../health";
import {
  type MirrorAction,
  type MirrorExistingRow,
  type MirrorSourceFile,
  REMOVED_HASH_PREFIX,
  isRemovedHash,
  planCollectorMirror,
  removedHash,
} from "../mirror";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../../../../work/fixtures/collectors");

function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, `${name}.toml`), "utf8");
}

const ZENDESK_PATH = "work/collectors/support-zendesk.toml";
const ZENDESK_TEXT = fixture("support-zendesk");
const ZENDESK_HASH = collectorFileHash(ZENDESK_TEXT);
const ZENDESK_CONNECTION = "conn_01K5ZD7Q4R";

const INBOX_PATH = "work/collectors/inbox.toml";
const INBOX_TEXT = fixture("inbox");

const SLACK_PATH = "work/collectors/eng-requests.toml";
const SLACK_CONNECTION = "conn_01K5ZS2V8W";

/** Connection ids as files name them, mapped to the rows they stand for. */
const CONNECTIONS: ReadonlyMap<string, string> = new Map([
  [ZENDESK_CONNECTION, "connrow-zendesk"],
  [SLACK_CONNECTION, "connrow-slack"],
]);
const NO_CONNECTIONS: ReadonlyMap<string, string> = new Map();

const zendeskFile: MirrorSourceFile = { path: ZENDESK_PATH, text: ZENDESK_TEXT };
const inboxFile: MirrorSourceFile = { path: INBOX_PATH, text: INBOX_TEXT };
const slackFile: MirrorSourceFile = { path: SLACK_PATH, text: fixture("eng-requests") };

/** What the plan carries for the Zendesk fixture once it reads. */
const zendeskRead = expect.objectContaining({
  path: ZENDESK_PATH,
  name: "support-zendesk",
  type: "zendesk",
  connection: ZENDESK_CONNECTION,
  fileHash: ZENDESK_HASH,
});

/** The row the Zendesk fixture made, current with its file unless a test says otherwise. */
function zendeskRow(fields: Partial<MirrorExistingRow> = {}): MirrorExistingRow {
  return {
    id: "col-zendesk",
    name: "support-zendesk",
    type: "zendesk",
    connectionId: "connrow-zendesk",
    fileHash: ZENDESK_HASH,
    health: "healthy",
    ...fields,
  };
}

function row(fields: Partial<MirrorExistingRow> & Pick<MirrorExistingRow, "name">): MirrorExistingRow {
  return {
    id: `col-${fields.name}`,
    type: "zendesk",
    connectionId: null,
    fileHash: "sha256:old",
    health: "healthy",
    ...fields,
  };
}

function summary(action: MirrorAction): string {
  switch (action.kind) {
    case "create":
      return `create ${action.file.path}`;
    case "update":
      return `update ${action.id}`;
    case "pause":
      return `pause ${action.name}`;
    case "invalid":
      return `invalid ${action.path}`;
  }
}

describe("planCollectorMirror", () => {
  it("creates a row for a new file, linked to the connection the file names", () => {
    expect(planCollectorMirror([zendeskFile], [], CONNECTIONS)).toEqual({
      actions: [{ kind: "create", file: zendeskRead, connectionId: "connrow-zendesk" }],
      warnings: [],
    });
  });

  it("creates an email row with no connection and no warning", () => {
    expect(planCollectorMirror([inboxFile], [], NO_CONNECTIONS)).toEqual({
      actions: [
        {
          kind: "create",
          file: expect.objectContaining({ name: "inbox", type: "email", connection: null }),
          connectionId: null,
        },
      ],
      warnings: [],
    });
  });

  it("updates a row when its file's hash changes", () => {
    const plan = planCollectorMirror(
      [zendeskFile],
      [zendeskRow({ fileHash: "sha256:old", health: "lagging" })],
      CONNECTIONS,
    );
    expect(plan).toEqual({
      actions: [
        {
          kind: "update",
          id: "col-zendesk",
          file: zendeskRead,
          connectionId: "connrow-zendesk",
          resume: false,
        },
      ],
      warnings: [],
    });
  });

  it("updates a row when the file's connection now points at another row", () => {
    const plan = planCollectorMirror(
      [zendeskFile],
      [zendeskRow({ connectionId: "connrow-old" })],
      CONNECTIONS,
    );
    expect(plan.actions).toEqual([
      {
        kind: "update",
        id: "col-zendesk",
        file: zendeskRead,
        connectionId: "connrow-zendesk",
        resume: false,
      },
    ]);
  });

  it("plans nothing for rows that match their files", () => {
    const inboxRow = row({
      name: "inbox",
      type: "email",
      connectionId: null,
      fileHash: collectorFileHash(INBOX_TEXT),
    });
    expect(planCollectorMirror([zendeskFile, inboxFile], [zendeskRow(), inboxRow], CONNECTIONS)).toEqual(
      { actions: [], warnings: [] },
    );
  });

  it("pauses a row whose file is gone and marks its hash removed", () => {
    expect(planCollectorMirror([], [zendeskRow({ health: "failing" })], CONNECTIONS)).toEqual({
      actions: [
        {
          kind: "pause",
          id: "col-zendesk",
          name: "support-zendesk",
          fileHash: `removed:${ZENDESK_HASH}`,
        },
      ],
      warnings: [],
    });
  });

  it("marks a removed row that a person had paused as removed:paused", () => {
    expect(planCollectorMirror([], [zendeskRow({ health: "paused" })], CONNECTIONS).actions).toEqual([
      {
        kind: "pause",
        id: "col-zendesk",
        name: "support-zendesk",
        fileHash: `removed:paused:${ZENDESK_HASH}`,
      },
    ]);
  });

  it("resumes a row the mirror paused when its file comes back unchanged", () => {
    const plan = planCollectorMirror(
      [zendeskFile],
      [zendeskRow({ fileHash: `removed:${ZENDESK_HASH}`, health: "paused" })],
      CONNECTIONS,
    );
    expect(plan.actions).toEqual([
      {
        kind: "update",
        id: "col-zendesk",
        file: zendeskRead,
        connectionId: "connrow-zendesk",
        resume: true,
      },
    ]);
  });

  it("keeps a row paused when its file comes back if a person paused it first", () => {
    const plan = planCollectorMirror(
      [zendeskFile],
      [zendeskRow({ fileHash: `removed:paused:${ZENDESK_HASH}`, health: "paused" })],
      CONNECTIONS,
    );
    expect(plan.actions).toEqual([
      {
        kind: "update",
        id: "col-zendesk",
        file: zendeskRead,
        connectionId: "connrow-zendesk",
        resume: false,
      },
    ]);
  });

  it("reports a file that changes its collector's type and leaves the row alone", () => {
    expect(planCollectorMirror([zendeskFile], [zendeskRow({ type: "jira" })], CONNECTIONS)).toEqual({
      actions: [
        {
          kind: "invalid",
          path: ZENDESK_PATH,
          errors: [
            "type: support-zendesk is a jira collector and cannot become zendesk; give the new collector a new file name",
          ],
        },
      ],
      warnings: [],
    });
  });

  it("reports a file that does not read and does not pause its row", () => {
    const broken: MirrorSourceFile = { path: "work/collectors/broken.toml", text: 'name = "broken' };
    const plan = planCollectorMirror([broken], [row({ name: "broken" })], CONNECTIONS);
    expect(plan).toEqual({
      actions: [
        {
          kind: "invalid",
          path: "work/collectors/broken.toml",
          errors: [expect.stringMatching(/^not valid TOML: /)],
        },
      ],
      warnings: [],
    });
  });

  it("reports a file whose name does not match its path", () => {
    const renamed: MirrorSourceFile = { path: "work/collectors/other.toml", text: ZENDESK_TEXT };
    expect(planCollectorMirror([renamed], [], CONNECTIONS).actions).toEqual([
      {
        kind: "invalid",
        path: "work/collectors/other.toml",
        errors: ["name: support-zendesk does not match the file name other"],
      },
    ]);
  });

  it("warns when a file names a connection no row matches, and creates the row unlinked", () => {
    expect(planCollectorMirror([zendeskFile], [], NO_CONNECTIONS)).toEqual({
      actions: [{ kind: "create", file: zendeskRead, connectionId: null }],
      warnings: [
        "work/collectors/support-zendesk.toml: no connection in this workspace has the id conn_01K5ZD7Q4R; the collector stores deliveries and fetches nothing until one does",
      ],
    });
  });

  it("unlinks a row whose connection no longer matches, and warns", () => {
    const plan = planCollectorMirror([zendeskFile], [zendeskRow()], NO_CONNECTIONS);
    expect(plan.actions).toEqual([
      { kind: "update", id: "col-zendesk", file: zendeskRead, connectionId: null, resume: false },
    ]);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("no connection in this workspace has the id conn_01K5ZD7Q4R");
  });

  it("ignores files outside work/collectors, so they keep no row alive", () => {
    const outside: MirrorSourceFile[] = [
      { path: "work/other/support-zendesk.toml", text: ZENDESK_TEXT },
      { path: "work/collectors/nested/support-zendesk.toml", text: ZENDESK_TEXT },
      { path: "support-zendesk.toml", text: ZENDESK_TEXT },
      { path: "work/collectors/README.md", text: "# Collectors" },
    ];
    expect(planCollectorMirror(outside, [], CONNECTIONS)).toEqual({ actions: [], warnings: [] });
    expect(planCollectorMirror(outside, [zendeskRow()], CONNECTIONS).actions).toEqual([
      {
        kind: "pause",
        id: "col-zendesk",
        name: "support-zendesk",
        fileHash: `removed:${ZENDESK_HASH}`,
      },
    ]);
  });

  it("does not pause a row that is already marked removed", () => {
    const rows = [
      zendeskRow({ fileHash: `removed:${ZENDESK_HASH}`, health: "paused" }),
      row({ name: "inbox", type: "email", fileHash: "removed:paused:sha256:inbox", health: "paused" }),
    ];
    expect(planCollectorMirror([], rows, CONNECTIONS)).toEqual({ actions: [], warnings: [] });
  });

  it("orders file actions by path, then pauses in row order", () => {
    const plan = planCollectorMirror(
      [zendeskFile, inboxFile, slackFile],
      [row({ name: "gone-b" }), row({ name: "gone-a" })],
      CONNECTIONS,
    );
    expect(plan.actions.map(summary)).toEqual([
      "create work/collectors/eng-requests.toml",
      "create work/collectors/inbox.toml",
      "create work/collectors/support-zendesk.toml",
      "pause gone-b",
      "pause gone-a",
    ]);
    expect(plan.warnings).toEqual([]);
  });
});

describe("isRemovedHash and removedHash", () => {
  it("marks a removed row's hash with the removed: prefix", () => {
    expect(REMOVED_HASH_PREFIX).toBe("removed:");
    expect(isRemovedHash("removed:sha256:abc")).toBe(true);
    expect(isRemovedHash("removed:paused:sha256:abc")).toBe(true);
    expect(isRemovedHash("sha256:abc")).toBe(false);
    expect(isRemovedHash("")).toBe(false);
  });

  it("keeps whether a person paused the row before its file went", () => {
    const healths: CollectorHealth[] = ["healthy", "lagging", "failing"];
    for (const health of healths)
      expect(removedHash({ fileHash: "sha256:abc", health })).toBe("removed:sha256:abc");
    expect(removedHash({ fileHash: "sha256:abc", health: "paused" })).toBe(
      "removed:paused:sha256:abc",
    );
  });
});
