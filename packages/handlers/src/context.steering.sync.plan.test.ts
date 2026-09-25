/**
 * The repository sync's planner (ADR-182): what the registry must change to
 * match the record files on the production branch. Pure, so every case here
 * is a file tree and a registry in, a plan out.
 *
 * The cases that matter most are the ones a person causes by editing the
 * repository by hand: renaming a file, editing its lineage, deleting it,
 * breaking it. Each keeps the record's identity where it can and says so
 * where it cannot.
 */
import { describe, expect, it } from "vitest";
import { buildRecordFile, serializeRecordFile } from "./context.steering.file";
import {
  contentKeyOf,
  planSync,
  type RegistryRecord,
  type RepoFile,
} from "./context.steering.sync.plan";

const RULES = ".oxagen/rules";

function recordText(
  lineageId: string,
  over: {
    statement?: string;
    label?: string | null;
    kind?: "rule" | "constraint";
    sharingScope?: "workspace" | "repository";
  } = {},
): string {
  return serializeRecordFile(
    buildRecordFile({
      lineageId,
      label: over.label === undefined ? "A label" : over.label,
      kind: over.kind ?? "rule",
      force: "must",
      sharingScope: over.sharingScope ?? "workspace",
      statement: over.statement ?? `Follow ${lineageId}.`,
      origin: "user",
      proposalPublicId: "prp_test",
      setId: "acme.platform",
    }),
  );
}

const file = (path: string, text: string): RepoFile => ({ path, text });

let nextId = 0;
function registered(
  lineageId: string,
  over: Partial<RegistryRecord> & { text?: string } = {},
): RegistryRecord {
  nextId += 1;
  const text = over.text ?? recordText(lineageId);
  return {
    id: `rec-${nextId}`,
    slug: lineageId,
    path: `${RULES}/${lineageId}.toml`,
    status: "active",
    deleted: false,
    label: "A label",
    kind: "rule",
    constraintEffect: null,
    statement: `Follow ${lineageId}.`,
    body: text,
    ...over,
  };
}

describe("planSync", () => {
  it("publishes a lineage the registry has never held", () => {
    const plan = planSync({
      files: [file(`${RULES}/ctx.a.one.toml`, recordText("ctx.a.one"))],
      records: [],
    });
    expect(plan.publish).toHaveLength(1);
    expect(plan.publish[0]).toMatchObject({
      recordId: null,
      lineageId: "ctx.a.one",
      path: `${RULES}/ctx.a.one.toml`,
    });
    expect(plan.retire).toEqual([]);
    expect(plan.findings).toEqual([]);
  });

  it("changes nothing when every file matches the registry", () => {
    const rec = registered("ctx.a.one");
    const plan = planSync({
      files: [file(rec.path!, rec.body!)],
      records: [rec],
    });
    expect(plan).toEqual({ publish: [], update: [], retire: [], findings: [] });
  });

  // The whole reason the file name is not the identity: a person renames or
  // moves a file and the record keeps its id, versions and ledger.
  it("follows a renamed file to its new path without a new version", () => {
    const rec = registered("ctx.a.one");
    const plan = planSync({
      files: [file(`${RULES}/team/renamed.toml`, rec.body!)],
      records: [rec],
    });
    expect(plan.publish).toEqual([]);
    expect(plan.retire).toEqual([]);
    expect(plan.update).toEqual([
      {
        recordId: rec.id,
        lineageId: "ctx.a.one",
        path: `${RULES}/team/renamed.toml`,
      },
    ]);
  });

  it("publishes a new version when a file's statement changes", () => {
    const rec = registered("ctx.a.one");
    const plan = planSync({
      files: [
        file(rec.path!, recordText("ctx.a.one", { statement: "Say it anew." })),
      ],
      records: [rec],
    });
    expect(plan.publish).toHaveLength(1);
    expect(plan.publish[0]).toMatchObject({
      recordId: rec.id,
      content: { statement: "Say it anew." },
    });
  });

  // A label is a name, not content (ADR-178): renaming a record is not a new
  // version of what it says.
  it("relabels a record without a new version", () => {
    const rec = registered("ctx.a.one");
    const plan = planSync({
      files: [file(rec.path!, recordText("ctx.a.one", { label: "New name" }))],
      records: [rec],
    });
    expect(plan.publish).toEqual([]);
    expect(plan.update).toEqual([
      { recordId: rec.id, lineageId: "ctx.a.one", label: "New name" },
    ]);
  });

  // The lineage_id was edited inside a file that stayed where it was. The
  // record keeps its id and takes the new lineage as its slug; the lineage is
  // part of the content, so it is also a new version.
  it("keeps a record's id when its lineage is edited in place", () => {
    const rec = registered("ctx.a.one");
    const plan = planSync({
      files: [file(rec.path!, recordText("ctx.a.renamed"))],
      records: [rec],
    });
    expect(plan.retire).toEqual([]);
    expect(plan.publish).toHaveLength(1);
    expect(plan.publish[0]).toMatchObject({
      recordId: rec.id,
      lineageId: "ctx.a.renamed",
    });
    expect(plan.update).toEqual([
      { recordId: rec.id, lineageId: "ctx.a.renamed", slug: "ctx.a.renamed" },
    ]);
  });

  it("retires a record whose file is gone from the branch", () => {
    const rec = registered("ctx.a.one");
    const plan = planSync({ files: [], records: [rec] });
    expect(plan.retire).toEqual([
      { recordId: rec.id, lineageId: "ctx.a.one", reason: "file_removed" },
    ]);
  });

  // Records written before the repository was the source have no path. The
  // sync did not create them and must not retire them: the advisor's one
  // data-loss case.
  it("never retires a record that has no path under the rules directory", () => {
    const legacy = registered("rec_legacy_abc123", { path: null });
    const stella = registered("ctx.b.two", {
      path: ".stella/rules/ctx.b.two.toml",
    });
    const plan = planSync({ files: [], records: [legacy, stella] });
    expect(plan.retire).toEqual([]);
  });

  it("retires a record whose file marks it retracted", () => {
    const rec = registered("ctx.a.one");
    const text = rec.body!.replace('status = "active"', 'status = "retracted"');
    const plan = planSync({ files: [file(rec.path!, text)], records: [rec] });
    expect(plan.retire).toEqual([
      { recordId: rec.id, lineageId: "ctx.a.one", reason: "file_retracted" },
    ]);
    expect(plan.publish).toEqual([]);
  });

  it("brings back a retired record whose file returns", () => {
    const rec = registered("ctx.a.one", { status: "retired" });
    const plan = planSync({
      files: [file(rec.path!, rec.body!)],
      records: [rec],
    });
    expect(plan.publish).toHaveLength(1);
    expect(plan.publish[0]?.recordId).toBe(rec.id);
  });

  describe("a file that cannot be published", () => {
    it("reports TOML that does not parse, and keeps the record it held", () => {
      const rec = registered("ctx.a.one");
      const plan = planSync({
        files: [file(rec.path!, "schema = [unclosed")],
        records: [rec],
      });
      expect(plan.findings).toHaveLength(1);
      expect(plan.findings[0]).toMatchObject({
        level: "error",
        code: "not_toml",
        path: rec.path,
      });
      expect(plan.retire).toEqual([]);
      expect(plan.publish).toEqual([]);
    });

    it("reports a schema problem and keeps the record it held", () => {
      const rec = registered("ctx.a.one");
      const plan = planSync({
        files: [
          file(rec.path!, rec.body!.replace(/^kind = .*$/m, 'kind = "wish"')),
        ],
        records: [rec],
      });
      expect(plan.findings[0]).toMatchObject({
        level: "error",
        code: "schema",
      });
      expect(plan.retire).toEqual([]);
    });

    it("refuses a record carrying a credential and keeps the last good version", () => {
      const rec = registered("ctx.a.one");
      const plan = planSync({
        files: [
          file(
            rec.path!,
            recordText("ctx.a.one", {
              statement: "Use ghp_0123456789abcdefghijklmnopqrstuvwx to push.",
            }),
          ),
        ],
        records: [rec],
      });
      expect(plan.findings[0]).toMatchObject({
        level: "error",
        code: "secret",
        lineageId: "ctx.a.one",
      });
      expect(plan.publish).toEqual([]);
      expect(plan.retire).toEqual([]);
    });

    it("refuses a lineage that is not a lineage id", () => {
      const text = recordText("ctx.a.one").replace(
        'lineage_id = "ctx.a.one"',
        'lineage_id = "Not A Lineage"',
      );
      const plan = planSync({
        files: [file(`${RULES}/bad.toml`, text)],
        records: [],
      });
      expect(plan.findings[0]).toMatchObject({ code: "lineage_invalid" });
      expect(plan.publish).toEqual([]);
    });

    it("refuses a sharing scope the registry cannot hold", () => {
      const text = recordText("ctx.a.one").replace(
        'sharing_scope = "workspace"',
        'sharing_scope = "personal"',
      );
      const plan = planSync({
        files: [file(`${RULES}/ctx.a.one.toml`, text)],
        records: [],
      });
      expect(plan.findings[0]).toMatchObject({ code: "sharing_scope" });
      expect(plan.publish).toEqual([]);
    });

    // One lineage, one file. The file at the registry's path keeps it; the
    // copy is reported and publishes nothing.
    it("keeps the registry's file when two files hold one lineage", () => {
      const rec = registered("ctx.a.one");
      const plan = planSync({
        files: [
          file(rec.path!, rec.body!),
          file(`${RULES}/copy.toml`, rec.body!),
        ],
        records: [rec],
      });
      expect(plan.findings).toHaveLength(1);
      expect(plan.findings[0]).toMatchObject({
        code: "duplicate_lineage",
        path: `${RULES}/copy.toml`,
      });
      expect(plan.update).toEqual([]);
      expect(plan.retire).toEqual([]);
    });

    it("publishes neither copy of a new lineage held by two files", () => {
      const text = recordText("ctx.a.one");
      const plan = planSync({
        files: [file(`${RULES}/a.toml`, text), file(`${RULES}/b.toml`, text)],
        records: [],
      });
      expect(plan.publish).toEqual([]);
      expect(plan.findings.map((f) => f.code)).toEqual([
        "duplicate_lineage",
        "duplicate_lineage",
      ]);
    });
  });

  describe("stamps", () => {
    // A person writing a record by hand cannot compute a SHA-256. The record
    // publishes, and the warning says how to get the stamps written.
    it("publishes an unstamped hand-written record with a warning", () => {
      const text = recordText("ctx.a.one")
        .replace(/^record_id = .*\n/m, "")
        .replace(/^record_hash = .*\n/m, "");
      const plan = planSync({
        files: [file(`${RULES}/ctx.a.one.toml`, text)],
        records: [],
      });
      expect(plan.publish).toHaveLength(1);
      expect(plan.findings).toEqual([
        expect.objectContaining({ level: "warning", code: "stale_stamp" }),
      ]);
    });

    // #4118: a review suggestion rewrote the statement and left the old
    // record_hash. The file on the branch is what is in force, so it
    // publishes, with a warning.
    it("publishes an edited record whose stamp is stale, with a warning", () => {
      const rec = registered("ctx.a.one");
      const text = rec.body!.replace(
        'statement = "Follow ctx.a.one."',
        'statement = "Follow ctx.a.one, always."',
      );
      const plan = planSync({ files: [file(rec.path!, text)], records: [rec] });
      expect(plan.publish).toHaveLength(1);
      expect(plan.publish[0]?.content.statement).toBe(
        "Follow ctx.a.one, always.",
      );
      expect(plan.findings).toEqual([
        expect.objectContaining({ level: "warning", code: "stale_stamp" }),
      ]);
    });

    it("reads an unstamped file and its stamped twin as the same content", () => {
      const stamped = recordText("ctx.a.one");
      const bare = stamped
        .replace(/^record_id = .*\n/m, "")
        .replace(/^record_hash = .*\n/m, "");
      expect(contentKeyOf(bare)).toBe(contentKeyOf(stamped));
      expect(contentKeyOf("not toml [")).toBeNull();
    });
  });

  describe("constraints", () => {
    // The record file has no field for a constraint's effect, so the effect
    // lives on the registry row. An existing constraint keeps it.
    it("carries an existing constraint's effect onto its new version", () => {
      const rec = registered("ctx.a.one", {
        kind: "constraint",
        constraintEffect: "forbid",
      });
      const plan = planSync({
        files: [
          file(
            rec.path!,
            recordText("ctx.a.one", {
              kind: "constraint",
              statement: "Never force-push main.",
            }),
          ),
        ],
        records: [rec],
      });
      expect(plan.publish[0]?.content.constraintEffect).toBe("forbid");
    });

    it("refuses a constraint the registry has never held as one", () => {
      const plan = planSync({
        files: [
          file(
            `${RULES}/ctx.a.one.toml`,
            recordText("ctx.a.one", { kind: "constraint" }),
          ),
        ],
        records: [],
      });
      expect(plan.findings[0]).toMatchObject({ code: "constraint_effect" });
      expect(plan.publish).toEqual([]);
    });

    it("refuses a constraint that contradicts one in force", () => {
      const forbid = registered("ctx.a.forbid", {
        kind: "constraint",
        constraintEffect: "forbid",
        statement: "Push to main.",
      });
      const require = registered("ctx.a.require", {
        kind: "constraint",
        constraintEffect: "require",
        statement: "Something else.",
      });
      const plan = planSync({
        files: [
          file(forbid.path!, forbid.body!),
          file(
            require.path!,
            recordText("ctx.a.require", {
              kind: "constraint",
              statement: "push to main.",
            }),
          ),
        ],
        records: [forbid, require],
      });
      expect(plan.findings).toContainEqual(
        expect.objectContaining({
          code: "constraint_conflict",
          lineageId: "ctx.a.require",
        }),
      );
      expect(plan.publish.map((p) => p.lineageId)).not.toContain(
        "ctx.a.require",
      );
    });
  });

  it("leaves a deferred lineage alone entirely", () => {
    const rec = registered("ctx.a.one");
    const plan = planSync({
      files: [
        file(rec.path!, recordText("ctx.a.one", { statement: "Changed." })),
      ],
      records: [rec],
      defer: new Set(["ctx.a.one"]),
    });
    expect(plan).toEqual({ publish: [], update: [], retire: [], findings: [] });
  });

  it("ignores governance.toml and TOML that declares no records", () => {
    const plan = planSync({
      files: [
        file(`${RULES}/governance.toml`, 'mode = "team"\n'),
        file(`${RULES}/notes.toml`, 'owner = "platform"\n'),
        file(`${RULES}/README.md`, "# rules\n"),
      ],
      records: [],
    });
    expect(plan).toEqual({ publish: [], update: [], retire: [], findings: [] });
  });

  it("publishes each record of a file that holds several", () => {
    const one = recordText("ctx.a.one");
    const two = recordText("ctx.a.two");
    const records = [one, two].map((t) => t.slice(t.indexOf("[[record]]")));
    const head = one.slice(0, one.indexOf("[[record]]"));
    const plan = planSync({
      files: [file(`${RULES}/both.toml`, `${head}${records.join("\n")}`)],
      records: [],
    });
    expect(plan.publish.map((p) => p.lineageId).sort()).toEqual([
      "ctx.a.one",
      "ctx.a.two",
    ]);
    expect(plan.findings).toEqual([]);
  });
});
