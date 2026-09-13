import type { schema } from "@oxagen/database";
import { describe, expect, it } from "vitest";
import { SteeringRecord } from "@/data/contracts/steering";
import {
  type ContextRecordRow,
  RECORD_BODY_INVALID,
  TomlSubsetError,
  commitFromProvenance,
  parseRecordToml,
  readSteeringRecords,
  toSteeringRecord,
} from "./steering";

// ---- representative rows, typed from the drizzle tables ----------------------

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0de1";
const LINEAGE = "ctx.acme.platform.agents-md-wins-conflicts";

// A published record file as Stella writes it (.stella/rules), with the
// constructs the reader must survive: a header comment, defaults, an indented
// sub-table, an inline table, a multi-line array, and a nested `kind` that is
// not the record's kind.
const BODY = `# Published as a context record.
schema = "context-record/v0.1"
set_id = "acme.platform"

[defaults]
sharing_scope = "workspace"
status        = "active"

[defaults.provenance]
repo   = "git@github.com:acme/platform"
commit = "8b63b88a"

[[record]]
lineage_id = "${LINEAGE}"
kind       = "rule"
statement  = "When CLAUDE.md and AGENTS.md disagree, AGENTS.md wins."
tags       = ["precedence", "conflict"]

  [record.provenance]
  source_lines = [
      88,
      89,
  ]

  [record.steering]
  force      = "must"
  precedence = 100
  applies_to = { paths = ["CLAUDE.md", "AGENTS.md"], keywords = ["precedence"] }

  [record.enforcement]
  mode = "soft"

  [record.truth]
  basis      = "decree"
  confidence = 95

    [record.truth.probe]
    kind    = "file_contains"
    path    = "AGENTS.md"
    pattern = "AGENTS.md wins"
`;

const recordRow: typeof schema.contextRecords.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000c7a01",
  publicId: "ctr_01K5RU4A8XQ2P0M7N3JH5B",
  createdAt: new Date("2026-09-01T10:00:00Z"),
  updatedAt: new Date("2026-09-04T10:00:00Z"),
  createdByUserId: null,
  updatedByUserId: null,
  orgId: ORG,
  workspaceId: WS,
  deletedAt: null,
  deletedByUserId: null,
  slug: LINEAGE,
  title: "AGENTS.md wins conflicts",
  status: "active",
  activeVersionId: "0192d4a8-7c1e-7a00-8000-0000000c7b01",
  activatedByUserId: null,
  activatedAt: new Date("2026-09-04T10:00:00Z"),
};

const versionRow: typeof schema.contextRecordVersions.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000c7b01",
  publicId: "crv_01K5RU4B2ZC9W1T5Y6QK8D",
  createdAt: new Date("2026-09-01T10:00:00Z"),
  updatedAt: new Date("2026-09-01T10:00:00Z"),
  createdByUserId: null,
  updatedByUserId: null,
  orgId: ORG,
  workspaceId: WS,
  versionNumber: 2,
  isLatest: true,
  parentVersionId: null,
  publishedAt: new Date("2026-09-01T10:00:00Z"),
  recordId: recordRow.id,
  body: BODY,
  checksum: "a".repeat(64),
  provenance: [
    { type: "file", uri: ".oxagen/rules/agents-md-wins-conflicts.toml" },
    { type: "commit", digest: "A4C91E2B7D" },
  ],
};

const promotionRow: typeof schema.contextPromotions.$inferSelect = {
  id: "0192d4a8-7c1e-7a00-8000-0000000c7c01",
  publicId: "ctp_01K5RU4C7HV3S8R2X4LM9F",
  createdAt: new Date("2026-09-04T12:30:00Z"),
  createdByUserId: null,
  orgId: ORG,
  workspaceId: WS,
  recordId: recordRow.id,
  versionId: versionRow.id,
  seq: 1,
  action: "promote",
  approverUserId: null,
  policyVersion: "solo@1",
  prevChainDigest: null,
  chainDigest: "b".repeat(64),
};

/** The row selectContextRecordRows returns for these three table rows. */
const row = (over: Partial<ContextRecordRow> = {}): ContextRecordRow => ({
  publicId: recordRow.publicId,
  slug: recordRow.slug,
  status: recordRow.status,
  body: versionRow.body,
  provenance: versionRow.provenance,
  versionPublishedAt: versionRow.publishedAt,
  promotedAt: promotionRow.createdAt,
  ...over,
});

// ---- the TOML subset ---------------------------------------------------------

describe("parseRecordToml", () => {
  it("reads a published record file into tables", () => {
    const file = parseRecordToml(BODY);
    expect(file.schema).toBe("context-record/v0.1");
    expect(file.defaults).toEqual({
      sharing_scope: "workspace",
      status: "active",
      provenance: { repo: "git@github.com:acme/platform", commit: "8b63b88a" },
    });
    expect(file.record).toEqual([
      {
        lineage_id: LINEAGE,
        kind: "rule",
        statement: "When CLAUDE.md and AGENTS.md disagree, AGENTS.md wins.",
        tags: ["precedence", "conflict"],
        provenance: { source_lines: [{ scalar: "88" }, { scalar: "89" }] },
        steering: {
          force: "must",
          precedence: { scalar: "100" },
          applies_to: {
            paths: ["CLAUDE.md", "AGENTS.md"],
            keywords: ["precedence"],
          },
        },
        enforcement: { mode: "soft" },
        truth: {
          basis: "decree",
          confidence: { scalar: "95" },
          probe: {
            kind: "file_contains",
            path: "AGENTS.md",
            pattern: "AGENTS.md wins",
          },
        },
      },
    ]);
  });

  it("keeps every [[record]] of a set file, and attaches sub-tables to the latest", () => {
    const file = parseRecordToml(
      '[[record]]\nlineage_id = "ctx.a.one"\n[record.steering]\nforce = "may"\n[[record]]\nlineage_id = "ctx.a.two"\n',
    );
    expect(file.record).toEqual([
      { lineage_id: "ctx.a.one", steering: { force: "may" } },
      { lineage_id: "ctx.a.two" },
    ]);
  });

  it("decodes basic, literal and multi-line strings", () => {
    const file = parseRecordToml(
      [
        String.raw`basic = "tab\there \"quoted\" \\ \u00e9 \U0001F600"`,
        "literal = 'C:\\path\\no-escape'",
        'multi = """',
        "first line",
        "second \\",
        '    joined"""',
        "multi_literal = '''",
        "raw \\n kept'''",
        String.raw`escapes = "\b\f\r\n"`,
        "empty = {}",
        '"quoted key".dotted.leaf = true',
      ].join("\n"),
    );
    expect(file.basic).toBe('tab\there "quoted" \\ é 😀');
    expect(file.literal).toBe("C:\\path\\no-escape");
    expect(file.multi).toBe("first line\nsecond joined");
    expect(file.multi_literal).toBe("raw \\n kept");
    expect(file.escapes).toBe("\b\f\r\n");
    expect(file.empty).toEqual({});
    expect(file["quoted key"]).toEqual({
      dotted: { leaf: { scalar: "true" } },
    });
  });

  it("accepts CRLF line endings and a trailing comment after a value", () => {
    const file = parseRecordToml('a = "x" # note\r\n[t]\r\nb = "y"\r\n');
    expect(file).toEqual({ a: "x", t: { b: "y" } });
  });

  it.each([
    ["a duplicate key", 'a = "x"\na = "y"'],
    ["an unterminated string", 'a = "x'],
    ["a newline inside a single-line string", 'a = "x\ny"'],
    ["an invalid escape", String.raw`a = "\q"`],
    ["an invalid unicode escape", String.raw`a = "\u12G4"`],
    ["an unclosed table header", "[record\n"],
    ["an unclosed array-of-tables header", "[[record]\n"],
    ["trailing garbage after a value", 'a = "x" y'],
    ["a missing '='", 'a "x"'],
    ["a missing key", '= "x"'],
    ["a missing value", "a = \n"],
    ["an array with no separator", 'a = ["x" "y"]'],
    ["an inline table with no separator", 'a = { b = "x" c = "y" }'],
    ["a table header over a string", 'a = "x"\n[a]'],
    ["a dotted key through a string", 'a = "x"\na.b = "y"'],
    ["an array of tables over a table", "[a]\n[[a]]"],
    ["a table under an array of scalars", 'a = ["x"]\n[a.b]'],
  ])("rejects %s", (_label, source) => {
    expect(() => parseRecordToml(source)).toThrow(TomlSubsetError);
  });

  it("names the offset where reading stopped", () => {
    try {
      parseRecordToml('a = "x" y');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TomlSubsetError);
      expect((err as TomlSubsetError).offset).toBe(8);
      expect((err as TomlSubsetError).code).toBe("toml_subset_invalid");
    }
  });
});

// ---- rows → SteeringRecord ---------------------------------------------------

describe("toSteeringRecord", () => {
  it("maps a real record row through the SteeringRecord schema", () => {
    const mapped = toSteeringRecord(row());
    expect(mapped).toEqual({
      ok: true,
      record: {
        lineage: LINEAGE,
        kind: "rule",
        force: "must",
        enforcement: null,
        scope: "workspace",
        status: "published",
        statement: "When CLAUDE.md and AGENTS.md disagree, AGENTS.md wins.",
        effect: null,
        commitSha: "a4c91e2b7d",
        publishedOn: "2026-09-04",
      },
    });
    if (mapped.ok)
      expect(SteeringRecord.parse(mapped.record)).toEqual(mapped.record);
  });

  it.each([
    ["retired", "archived"],
    ["superseded", "archived"],
  ] as const)("shows a %s record as %s", (status, shown) => {
    const mapped = toSteeringRecord(row({ status }));
    expect(mapped.ok && mapped.record.status).toBe(shown);
  });

  it("prefers the record's own sharing scope over the file defaults", () => {
    const body = BODY.replace(
      'kind       = "rule"',
      'kind       = "rule"\nsharing_scope = "repository"',
    );
    const mapped = toSteeringRecord(row({ body }));
    expect(mapped.ok && mapped.record.scope).toBe("repository");
  });

  it("picks the record whose lineage is the slug out of a set file", () => {
    const body = `${BODY}\n[[record]]\nlineage_id = "ctx.acme.platform.other"\nkind = "fact"\nstatement = "x"\n`;
    const mapped = toSteeringRecord(row({ body }));
    expect(mapped.ok && mapped.record.kind).toBe("rule");
  });

  it("dates the record by the version's publication when no promotion is recorded", () => {
    const mapped = toSteeringRecord(row({ promotedAt: null }));
    expect(mapped.ok && mapped.record.publishedOn).toBe("2026-09-01");
  });

  it("reads a promotion date the driver returned as text", () => {
    const mapped = toSteeringRecord(
      row({ promotedAt: "2026-09-05T08:00:00+00:00" }),
    );
    expect(mapped.ok && mapped.record.publishedOn).toBe("2026-09-05");
  });

  const invalid = (field: string, over: Partial<ContextRecordRow>) =>
    [field, over] as const;

  it.each([
    invalid("body", { body: 'schema = "context-record/v0.1' }),
    invalid("schema", { body: BODY.replace("v0.1", "v0.2") }),
    invalid("lineage_id", { slug: "ctx.acme.platform.renamed" }),
    invalid("sharing_scope", {
      body: BODY.replace(
        'sharing_scope = "workspace"',
        'sharing_scope = "galaxy"',
      ),
    }),
    invalid("status", { status: "draft" }),
    invalid("kind", {
      body: BODY.replace('kind       = "rule"', 'kind = "observation"'),
    }),
    invalid("force", {
      body: BODY.replace('force      = "must"', 'force = "always"'),
    }),
    invalid("statement", {
      body: BODY.replace(/statement {2}= ".*"\n/, ""),
    }),
    invalid("lineage", {
      slug: "no-bare-unwrap",
      body: BODY.replace(LINEAGE, "no-bare-unwrap"),
    }),
  ])("marks a row invalid on %s", (field, over) => {
    expect(toSteeringRecord(row(over))).toEqual({
      ok: false,
      gap: "invalid",
      recordId: recordRow.publicId,
      field,
    });
  });

  it.each([
    [
      "sharing_scope",
      {
        body: BODY.replace(
          'sharing_scope = "workspace"',
          'sharing_scope = "user"',
        ),
      },
    ],
    [
      "sharing_scope",
      { body: BODY.replace('sharing_scope = "workspace"\n', "") },
    ],
    ["force", { body: BODY.replace('force      = "must"\n', "") }],
    ["commitSha", { provenance: [{ type: "file", uri: "x" }] }],
    ["publishedOn", { promotedAt: null, versionPublishedAt: null }],
    ["publishedOn", { promotedAt: "not a date", versionPublishedAt: null }],
  ] as const)(
    "marks a row unrepresentable when %s was never recorded",
    (field, over) => {
      expect(toSteeringRecord(row(over))).toEqual({
        ok: false,
        gap: "unrepresentable",
        recordId: recordRow.publicId,
        field,
      });
    },
  );
});

describe("commitFromProvenance", () => {
  it("reads the first commit entry's digest, lowercased", () => {
    expect(
      commitFromProvenance([
        { type: "review", by: "@marcus" },
        { type: "commit", digest: "ABCDEF1" },
        { type: "commit", digest: "1234567" },
      ]),
    ).toBe("abcdef1");
  });

  it.each([
    ["not an array", { type: "commit", digest: "abcdef1" }],
    ["null", null],
    ["a commit entry with no digest", [{ type: "commit" }]],
    ["a malformed entry", ["commit abcdef1"]],
  ])("finds none in %s", (_label, provenance) => {
    expect(commitFromProvenance(provenance)).toBeNull();
  });
});

// ---- the set → the read ------------------------------------------------------

describe("readSteeringRecords", () => {
  it("returns an empty workspace as an empty list, not a gap", () => {
    expect(readSteeringRecords([])).toEqual({ ok: true, value: [] });
  });

  it("returns every row when every row maps", () => {
    const second = row({
      publicId: "ctr_second",
      slug: "ctx.acme.platform.other",
      body: BODY.replace(LINEAGE, "ctx.acme.platform.other"),
    });
    const res = readSteeringRecords([row(), second]);
    expect(res.ok && res.value.map((r) => r.lineage)).toEqual([
      LINEAGE,
      "ctx.acme.platform.other",
    ]);
  });

  it("is not backed (M3) when one row lacks its publication commit, never a partial list", () => {
    expect(readSteeringRecords([row(), row({ provenance: [] })])).toEqual({
      ok: false,
      reason: "not_backed",
      milestone: "M3",
      gap: "G0",
    });
  });

  it("is an error when any stored body cannot be read, even beside a gap", () => {
    expect(
      readSteeringRecords([
        row({ provenance: [] }),
        row({ body: "not toml at all" }),
      ]),
    ).toEqual({
      ok: false,
      reason: "error",
      code: RECORD_BODY_INVALID,
      status: 502,
    });
  });
});
