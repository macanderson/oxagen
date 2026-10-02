import { describe, expect, it } from "vitest";
import {
  RECORD_KINDS,
  readSteeringRecord,
  recordStatement,
  STEERING_RECORD_FIELDS,
  type RecordKind,
  type RecordReadResult,
} from "@oxagen/oxagen/steering-repo/record";
import { memoryDescription } from "./naming";
import {
  archiveRecordText,
  memoryRecordKind,
  renderMemoryRecord,
  renderPromotedRecord,
} from "./record-file";
import type { MemoryRecordDraft } from "./types";

const RUN = "arun_01K5QK7D";
const AGENT = "a-intel.core.release-bot";
const REPO = "github.com/a-intel/platform";
const URI = `https://app.oxagen.ai/runs/${RUN}`;
const STATEMENT = "Run pnpm install after a bump. CI caches the lockfile.";
const OTHER_STATEMENT = "CI restored a stale cache after a bump.";

function draft(overrides: Partial<MemoryRecordDraft> = {}): MemoryRecordDraft {
  return {
    lineage: "pnpm-install-after-bump",
    kind: "memory",
    statement: STATEMENT,
    repos: [REPO],
    appliesTo: ["pnpm-lock.yaml"],
    tools: null,
    uri: URI,
    memories: [
      {
        agent: AGENT,
        run: RUN,
        statement: STATEMENT,
        evidence: [`frame:${RUN}/88`],
      },
      {
        agent: null,
        run: null,
        statement: OTHER_STATEMENT,
        evidence: [`${REPO}/pull/412`],
      },
    ],
    ...overrides,
  };
}

/** A file read as a record, or a failed test that names each issue. */
function readBack(text: string): Extract<RecordReadResult, { ok: true }> {
  const read = readSteeringRecord(text);
  if (!read.ok) {
    throw new Error(read.issues.map((issue) => issue.message).join("; "));
  }
  return read;
}

/** The top-level keys of a record file's frontmatter, in file order. */
function topLevelKeys(text: string): string[] {
  const close = text.indexOf("\n---\n");
  return text
    .slice(4, close)
    .split("\n")
    .flatMap((line) => /^([a-z_]+):/.exec(line)?.slice(1, 2) ?? []);
}

describe("memoryRecordKind", () => {
  it.each(["code-rule", "business-rule", "fact"] as const)(
    "keeps %s",
    (kind) => {
      expect(memoryRecordKind(kind)).toBe(kind);
    },
  );

  it.each(["constraint", "procedure", "skill", "preference", "memory"] as const)(
    "writes %s as memory",
    (kind) => {
      expect(memoryRecordKind(kind)).toBe("memory");
    },
  );
});

describe("renderMemoryRecord", () => {
  it("writes a repository memory in the layout Oxagen reads", () => {
    expect(renderMemoryRecord(draft())).toBe(
      [
        "---",
        "schema: steering-record/v1",
        "lineage: pnpm-install-after-bump",
        "label: Run pnpm install after a bump",
        `description: ${STATEMENT}`,
        "kind: memory",
        "force: info",
        "scope: repository",
        "repos:",
        `  - ${REPO}`,
        "applies_to:",
        "  - pnpm-lock.yaml",
        "status: active",
        "origin: inferred",
        "provenance:",
        "  source: run",
        `  uri: ${URI}`,
        "  memories:",
        `    - agent: ${AGENT}`,
        `      run: ${RUN}`,
        `      statement: ${STATEMENT}`,
        "      evidence:",
        `        - frame:${RUN}/88`,
        "    - agent: null",
        "      run: null",
        `      statement: ${OTHER_STATEMENT}`,
        "      evidence:",
        `        - ${REPO}/pull/412`,
        "---",
        "",
        STATEMENT,
        "",
      ].join("\n"),
    );
  });

  it("reads back as a steering record with a null agent and run kept", () => {
    const read = readBack(renderMemoryRecord(draft()));
    expect(read.record).toMatchObject({
      schema: "steering-record/v1",
      lineage: "pnpm-install-after-bump",
      kind: "memory",
      force: "info",
      scope: "repository",
      repos: [REPO],
      applies_to: ["pnpm-lock.yaml"],
      status: "active",
      origin: "inferred",
    });
    expect(read.record.provenance).toEqual({
      source: "run",
      uri: URI,
      memories: [
        {
          agent: AGENT,
          run: RUN,
          statement: STATEMENT,
          evidence: [`frame:${RUN}/88`],
        },
        {
          agent: null,
          run: null,
          statement: OTHER_STATEMENT,
          evidence: [`${REPO}/pull/412`],
        },
      ],
    });
    expect(recordStatement(read.body)).toBe(STATEMENT);
  });

  it.each(RECORD_KINDS)("writes a %s draft with the kind the record keeps", (kind) => {
    const kept: readonly RecordKind[] = ["code-rule", "business-rule", "fact"];
    const read = readBack(renderMemoryRecord(draft({ kind })));
    expect(read.record.kind).toBe(kept.includes(kind) ? kind : "memory");
  });

  // Each case is an object, since it.each spreads an array case into arguments.
  it.each([
    { name: "null", repos: null },
    { name: "empty", repos: [] },
  ])(
    "has workspace scope and no repos when the repos are $name",
    ({ repos }) => {
      const text = renderMemoryRecord(draft({ repos }));
      expect(text).not.toMatch(/^repos:/m);
      const read = readBack(text);
      expect(read.record.scope).toBe("workspace");
      expect(read.record.repos).toBeUndefined();
    },
  );

  it("leaves out a null or empty tools and applies_to", () => {
    const text = renderMemoryRecord(draft({ tools: null, appliesTo: [] }));
    expect(text).not.toMatch(/^(tools|applies_to):/m);
    const read = readBack(text);
    expect(read.record.tools).toBeUndefined();
    expect(read.record.applies_to).toBeUndefined();
  });

  it("writes each list without repeats", () => {
    const text = renderMemoryRecord(
      draft({
        repos: [REPO, REPO, "github.com/a-intel/billing"],
        tools: ["billing__create_refund", "billing__*", "billing__create_refund"],
        appliesTo: ["src/billing/**", "src/billing/**"],
      }),
    );
    const read = readBack(text);
    expect(read.record.repos).toEqual([REPO, "github.com/a-intel/billing"]);
    expect(read.record.tools).toEqual(["billing__create_refund", "billing__*"]);
    expect(read.record.applies_to).toEqual(["src/billing/**"]);
  });

  it("writes no anchor or alias when memories share one evidence list", () => {
    const evidence = [`frame:${RUN}/88`];
    const text = renderMemoryRecord(
      draft({
        memories: [
          { agent: AGENT, run: RUN, statement: STATEMENT, evidence },
          { agent: AGENT, run: RUN, statement: OTHER_STATEMENT, evidence },
        ],
      }),
    );
    expect(text).not.toMatch(/[:-] [&*]/);
    const read = readBack(text);
    expect(read.record.provenance.memories?.map((m) => m.evidence)).toEqual([
      evidence,
      evidence,
    ]);
  });

  it("writes the body with LF line endings and no blank lines around it", () => {
    const text = renderMemoryRecord(
      draft({ statement: "\r\n\r\nFirst line.\r\nSecond line.\rThird line.\r\n\r\n" }),
    );
    expect(text).not.toContain("\r");
    expect(text.endsWith("---\n\nFirst line.\nSecond line.\nThird line.\n")).toBe(
      true,
    );
    const read = readBack(text);
    expect(recordStatement(read.body)).toBe(
      "First line.\nSecond line.\nThird line.",
    );
    expect(read.record.label).toBe("First line");
    expect(read.record.description).toBe(
      "First line. Second line. Third line.",
    );
  });

  it("writes the fields in the order the schema lists them", () => {
    const keys = topLevelKeys(
      renderMemoryRecord(draft({ tools: ["billing__create_refund"] })),
    );
    expect(keys).toEqual([
      "schema",
      "lineage",
      "label",
      "description",
      "kind",
      "force",
      "scope",
      "repos",
      "tools",
      "applies_to",
      "status",
      "origin",
      "provenance",
    ]);
    expect(keys).toEqual(
      STEERING_RECORD_FIELDS.filter((field) => keys.includes(field)),
    );
  });

  it("does not fold a long statement across lines", () => {
    const long = `${"The cache key hashes the lockfile ".repeat(8).trim()}.`;
    const lines = renderMemoryRecord(
      draft({
        statement: long,
        memories: [{ agent: AGENT, run: RUN, statement: long, evidence: [] }],
      }),
    ).split("\n");
    expect(long.length).toBeGreaterThan(200);
    expect(lines).toContain(`      statement: ${long}`);
    expect(lines).toContain(`description: ${memoryDescription(long)}`);
    expect(lines.at(-2)).toBe(long);
  });

  it("throws when the draft cites no memory", () => {
    expect(() => renderMemoryRecord(draft({ memories: [] }))).toThrow(
      /^the memory record does not read as a steering record: /,
    );
  });

  it("throws when the statement is blank", () => {
    expect(() => renderMemoryRecord(draft({ statement: " \r\n \n" }))).toThrow(
      /the body is empty/,
    );
  });

  it("throws when the lineage is not a lineage", () => {
    expect(() => renderMemoryRecord(draft({ lineage: "Not A Lineage" }))).toThrow(
      /a lineage is lowercase letters/,
    );
  });
});

const ACTIVE = [
  "---",
  "schema: steering-record/v1",
  "lineage: a-intel.platform.ci-cache-key",
  "label: CI cache key includes the lockfile",
  "kind: memory",
  "force: info",
  "scope: repository",
  "repos:",
  `  - ${REPO}`,
  "status: active",
  "origin: inferred",
  "provenance:",
  "  source: run",
  "  uri: frame:run_01K5QK7D/88",
  "  memories:",
  "    - agent: null",
  "      run: null",
  "      statement: CI restored a stale pnpm cache.",
  "      evidence: []",
  "---",
  "",
  "The CI cache key hashes `pnpm-lock.yaml`.",
  "",
].join("\n");

const ARCHIVED = ACTIVE.replace("status: active", "status: archived");

describe("archiveRecordText", () => {
  it("sets status to archived and changes no other line", () => {
    const out = archiveRecordText(ACTIVE);
    expect(out).toBe(ARCHIVED);
    const before = ACTIVE.split("\n");
    const changed = out
      .split("\n")
      .filter((line, i) => line !== before[i]);
    expect(changed).toEqual(["status: archived"]);
    const read = readBack(out);
    expect(read.record.status).toBe("archived");
    expect(read.body).toBe(readBack(ACTIVE).body);
  });

  it("returns an archived record as it was", () => {
    expect(archiveRecordText(ARCHIVED)).toBe(ARCHIVED);
  });

  it("replaces a status value written over two lines", () => {
    const twoLines = ACTIVE.replace("status: active", "status:\n  active");
    expect(archiveRecordText(twoLines)).toBe(ARCHIVED);
  });

  it.each(["status: active", "status:\n  active"])(
    "archives a record whose last field is %j",
    (status) => {
      const close = "\n---\n\nThe CI";
      const text = ACTIVE.replace("status: active\n", "").replace(
        close,
        `\n${status}${close}`,
      );
      expect(archiveRecordText(text)).toBe(
        ACTIVE.replace("status: active\n", "").replace(
          close,
          `\nstatus: archived${close}`,
        ),
      );
    },
  );

  it("keeps a comment line that follows the status line", () => {
    const comment = "# set by the curator";
    const text = ACTIVE.replace("status: active", `status: active\n${comment}`);
    expect(archiveRecordText(text)).toBe(
      ACTIVE.replace("status: active", `status: archived\n${comment}`),
    );
  });

  it("throws on a record with no status field", () => {
    expect(() =>
      archiveRecordText(ACTIVE.replace("status: active\n", "")),
    ).toThrow(/^the record does not read, so it cannot be archived: /);
  });

  it("throws on a file with no frontmatter fences", () => {
    expect(() => archiveRecordText("status: active\n")).toThrow(
      /a record starts with --- on its own line/,
    );
  });

  it("throws on a file with CRLF line endings", () => {
    expect(() => archiveRecordText(ACTIVE.replace(/\n/g, "\r\n"))).toThrow(
      /cannot be archived/,
    );
  });

  it("throws on frontmatter that uses a YAML alias", () => {
    const aliased = ACTIVE.replace(
      "label: CI cache key includes the lockfile",
      "label: &label CI cache key includes the lockfile\ndescription: *label",
    );
    expect(() => archiveRecordText(aliased)).toThrow(/YAML (alias|anchor)/);
  });

  it("throws when the record has no body", () => {
    const bare = ACTIVE.slice(0, ACTIVE.indexOf("\n---\n") + "\n---\n".length);
    expect(() => archiveRecordText(bare)).toThrow(/the body is empty/);
  });
});

describe("renderPromotedRecord", () => {
  it("keeps the person's kind, force, and effect, and marks the record as a person's", () => {
    const text = renderPromotedRecord({
      ...draft(),
      kind: "constraint",
      force: "must",
      effect: "forbid",
    });
    const { record, body } = readBack(text);
    expect(record).toMatchObject({
      kind: "constraint",
      force: "must",
      effect: "forbid",
      scope: "repository",
      repos: [REPO],
      origin: "user",
      status: "active",
      provenance: { source: "run", uri: URI },
    });
    expect(record.provenance.memories).toHaveLength(2);
    expect(recordStatement(body)).toBe(STATEMENT);
  });

  it("writes a procedure as a procedure, where the curator would write a memory", () => {
    const promoted = readBack(
      renderPromotedRecord({ ...draft(), kind: "procedure", force: "should", effect: null }),
    );
    const curated = readBack(renderMemoryRecord({ ...draft(), kind: "procedure" }));
    expect(promoted.record).toMatchObject({ kind: "procedure", force: "should" });
    expect(promoted.record.effect).toBeUndefined();
    expect(curated.record).toMatchObject({ kind: "memory", force: "info", origin: "inferred" });
  });

  it("throws for a constraint with no effect, which no steering record may be", () => {
    expect(() =>
      renderPromotedRecord({ ...draft(), kind: "constraint", force: "must", effect: null }),
    ).toThrow(/does not read as a steering record/);
  });
});
