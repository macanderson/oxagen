// Unit tests for the steering record a steering PR writes in a steering repo
// (#4731), and for the four checks that read it. The handler tests in
// steering.pr.test.ts cover the same file end to end through the fake host.
import { describe, expect, it } from "vitest";
import { HandlerError } from "@oxagen/oxagen";
import { recordLineageFromPath } from "@oxagen/oxagen/steering-repo/paths";
import { readSteeringRecord, STEERING_RECORD_FIELDS } from "@oxagen/oxagen/steering-repo/record";
import { checksForPath, runChecks, type CheckContext } from "./context.steering.checks";
import {
  isSteeringRecordPath,
  kindCarriesProposal,
  renderSteeringRecord,
  steeringRecordKind,
  steeringRecordPath,
  type SteeringRecordDraft,
} from "./context.steering.record";
import { EDITED_ON_PR, STEERING_RECORD_CHECKS } from "./context.steering.record-checks";
import { stampRecordText } from "./steering-repo/stamp";

const LINEAGE = "ctx.release.no-reread-changelog";
const STATEMENT = "Do not re-read CHANGELOG.md more than once in a run.";
const RECORD_PATH = `steering/business-rules/${LINEAGE}.md`;

function draft(over: Partial<SteeringRecordDraft> = {}): SteeringRecordDraft {
  return {
    lineageId: LINEAGE,
    label: "Read the changelog once",
    kind: "rule",
    constraintEffect: null,
    force: "should",
    sharingScope: "workspace",
    statement: STATEMENT,
    origin: "user",
    proposalPublicId: "prp_1",
    ...over,
  };
}

/** The file a person moved and extended on the host: a code rule with repos, globs, and a description. */
const HELD_LINEAGE = "a-intel.platform.tenant-queries";
const HELD_STATEMENT = "Every tenant table query goes through withTenantDb.";
const HELD = `---
schema: steering-record/v1
lineage: ${HELD_LINEAGE}
label: Tenant queries use withTenantDb
description: Why the tenant wrapper matters.
kind: code-rule
force: must
scope: repository
repos:
  - github.com/a-intel/platform
applies_to:
  - "packages/handlers/**/*.ts"
load: match
status: active
origin: inferred
provenance:
  source: import
  uri: file://rules/tenant-queries.md
---

${HELD_STATEMENT}
`;

function heldDraft(over: Partial<SteeringRecordDraft> = {}): SteeringRecordDraft {
  return draft({
    lineageId: HELD_LINEAGE,
    label: "Tenant queries use withTenantDb",
    force: "must",
    sharingScope: "repository",
    statement: HELD_STATEMENT,
    ...over,
  });
}

function thrown(fn: () => unknown): HandlerError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HandlerError);
    return error as HandlerError;
  }
  throw new Error("expected the call to throw");
}

/** The top-level keys of a record's frontmatter, in the order the file holds them. */
function frontmatterKeys(text: string): string[] {
  const frontmatter = text.split("---\n")[1] ?? "";
  return [...frontmatter.matchAll(/^([a-z_]+):/gm)].map((match) => match[1] as string);
}

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    fileText: renderSteeringRecord(draft()).text,
    path: RECORD_PATH,
    changedPaths: [RECORD_PATH],
    proposal: {
      lineageId: LINEAGE,
      kind: "rule",
      force: "should",
      constraintEffect: null,
      sharingScope: "workspace",
      statement: STATEMENT,
      label: "Read the changelog once",
      rationale: "682 duplicate tool calls across 212 runs.",
      evidenceLinks: ["frame:run_01K5RH3G8K5PAS7D/12"],
    },
    published: null,
    activeRecords: [],
    ...over,
  };
}

describe("steeringRecordPath", () => {
  it.each([
    ["rule", "business-rules"],
    ["constraint", "constraints"],
    ["procedure", "procedures"],
    ["fact", "facts"],
    ["preference", "preferences"],
  ] as const)("puts a new %s in steering/%s/", (kind, folder) => {
    const path = steeringRecordPath(kind, LINEAGE);
    expect(path).toBe(`steering/${folder}/${LINEAGE}.md`);
    expect(isSteeringRecordPath(path)).toBe(true);
    expect(recordLineageFromPath(path)).toBe(LINEAGE);
  });

  it("puts a new memory where the curator puts one with no repository, path, or tool", () => {
    const path = steeringRecordPath("memory", LINEAGE);
    expect(path).toBe(`steering/memory/workspace/general/${LINEAGE}.md`);
    expect(isSteeringRecordPath(path)).toBe(true);
    expect(recordLineageFromPath(path)).toBe(LINEAGE);
  });
});

describe("isSteeringRecordPath", () => {
  it("reads a Markdown file under steering/ as a record, and nothing else", () => {
    expect(isSteeringRecordPath(RECORD_PATH)).toBe(true);
    expect(isSteeringRecordPath(null)).toBe(false);
    expect(isSteeringRecordPath(`.oxagen/rules/${LINEAGE}.toml`)).toBe(false);
    expect(isSteeringRecordPath("steering/governance.toml")).toBe(false);
    expect(isSteeringRecordPath(`steering/business-rules/${LINEAGE}.toml`)).toBe(false);
  });
});

describe("steeringRecordKind and kindCarriesProposal", () => {
  it("writes a rule as a business rule unless the record it revises is a code rule", () => {
    expect(steeringRecordKind("rule")).toBe("business-rule");
    expect(steeringRecordKind("rule", "code-rule")).toBe("code-rule");
    expect(steeringRecordKind("rule", "business-rule")).toBe("business-rule");
    expect(steeringRecordKind("rule", "fact")).toBe("business-rule");
    expect(steeringRecordKind("constraint", "code-rule")).toBe("constraint");
    expect(steeringRecordKind("memory")).toBe("memory");
  });

  it("lets a rule proposal ride either rule kind, and every other kind only its own", () => {
    expect(kindCarriesProposal("rule", "business-rule")).toBe(true);
    expect(kindCarriesProposal("rule", "code-rule")).toBe(true);
    expect(kindCarriesProposal("rule", "fact")).toBe(false);
    expect(kindCarriesProposal("fact", "fact")).toBe(true);
    expect(kindCarriesProposal("constraint", "business-rule")).toBe(false);
    expect(kindCarriesProposal("memory", "memory")).toBe(true);
  });
});

describe("renderSteeringRecord", () => {
  it("writes a new record in steering-record/v1, in schema order, with no id or hash", () => {
    const file = renderSteeringRecord(draft());
    const read = readSteeringRecord(file.text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toMatchObject({
      schema: "steering-record/v1",
      lineage: LINEAGE,
      label: "Read the changelog once",
      kind: "business-rule",
      force: "should",
      scope: "workspace",
      status: "active",
      origin: "user",
      provenance: { source: "proposal", uri: "oxagen:proposal/prp_1" },
    });
    expect(read.record.id).toBeUndefined();
    expect(read.record.hash).toBeUndefined();
    expect(read.record.effect).toBeUndefined();
    expect(read.body.trim()).toBe(STATEMENT);
    const keys = frontmatterKeys(file.text);
    const order = STEERING_RECORD_FIELDS.filter((field) => keys.includes(field));
    expect(keys).toEqual(order);
  });

  it("returns the id and hash the merge stamps into the same text", () => {
    const file = renderSteeringRecord(draft());
    const stamped = stampRecordText(file.text);
    expect(stamped).toMatchObject({ ok: true, id: file.id, hash: file.hash });
    expect(file.id).toMatch(/^rec_ctx_release_no_reread_changelog_/);
  });

  it("writes the statement with LF line endings and no surrounding blank lines", () => {
    const file = renderSteeringRecord(draft({ statement: "\r\n  First line.\r\nSecond line.\r\n\r\n" }));
    expect(file.text.endsWith("---\n\nFirst line.\nSecond line.\n")).toBe(true);
    expect(file.text).not.toContain("\r");
  });

  it("writes an agent's proposal as inferred", () => {
    const read = readSteeringRecord(renderSteeringRecord(draft({ origin: "inferred" })).text);
    expect(read.ok && read.record.origin).toBe("inferred");
  });

  it("writes a constraint's effect, and no effect on any other kind", () => {
    const constraint = readSteeringRecord(
      renderSteeringRecord(draft({ kind: "constraint", constraintEffect: "forbid", force: "must" })).text,
    );
    expect(constraint.ok && constraint.record).toMatchObject({ kind: "constraint", effect: "forbid" });
    const fact = readSteeringRecord(
      renderSteeringRecord(draft({ kind: "fact", constraintEffect: "forbid", force: "info" })).text,
    );
    expect(fact.ok && fact.record.kind).toBe("fact");
    expect(fact.ok && fact.record.effect).toBeUndefined();
  });

  it("revises a record from the file it lives in now: the proposal's fields, and the file's for the rest", () => {
    const statement = "Every query on a tenant table goes through withTenantDb(ctx, fn).";
    const file = renderSteeringRecord(heldDraft({ statement, origin: "user", proposalPublicId: "prp_2" }), HELD);
    const read = readSteeringRecord(file.text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.record).toMatchObject({
      lineage: HELD_LINEAGE,
      kind: "code-rule",
      force: "must",
      scope: "repository",
      repos: ["github.com/a-intel/platform"],
      applies_to: ["packages/handlers/**/*.ts"],
      load: "match",
      origin: "user",
      provenance: { source: "proposal", uri: "oxagen:proposal/prp_2" },
    });
    // The description explained the old statement, so it goes when the statement changes.
    expect(read.record.description).toBeUndefined();
    expect(read.body.trim()).toBe(statement);
  });

  it("keeps the file's description while the statement stays the same", () => {
    const read = readSteeringRecord(renderSteeringRecord(heldDraft({ force: "should" }), HELD).text);
    expect(read.ok && read.record).toMatchObject({
      description: "Why the tenant wrapper matters.",
      force: "should",
    });
  });

  it("drops the file's repos when the proposal widens the scope to the workspace", () => {
    const read = readSteeringRecord(renderSteeringRecord(heldDraft({ sharingScope: "workspace" }), HELD).text);
    expect(read.ok && read.record.scope).toBe("workspace");
    expect(read.ok && read.record.repos).toBeUndefined();
  });

  it("refuses a repository scope with no repos to keep, before anything is written", () => {
    const fresh = thrown(() => renderSteeringRecord(draft({ sharingScope: "repository" })));
    expect(fresh).toMatchObject({ code: "conflict", reason: "repository_scope_needs_repo" });
    expect(fresh.message).toContain(LINEAGE);
    // A file that does not read gives the revision nothing to keep either.
    const unreadable = thrown(() =>
      renderSteeringRecord(draft({ sharingScope: "repository" }), "not a steering record"),
    );
    expect(unreadable.reason).toBe("repository_scope_needs_repo");
  });

  it("refuses a proposal that does not make a steering record", () => {
    const error = thrown(() => renderSteeringRecord(draft({ label: "" })));
    expect(error).toMatchObject({ code: "conflict", reason: "record_unreadable" });
    expect(error.message).toContain(LINEAGE);
  });
});

describe("the steering record checks", () => {
  it("replace the TOML checks for a steering record path, and all six pass on the file Oxagen writes", async () => {
    expect(checksForPath(RECORD_PATH).schema).toBe(STEERING_RECORD_CHECKS.schema);
    expect(checksForPath(`.oxagen/rules/${LINEAGE}.toml`).schema).not.toBe(
      STEERING_RECORD_CHECKS.schema,
    );
    const ok = await runChecks(ctx(), {
      start: async () => {},
      finish: async (name, outcome) => {
        expect(outcome.ok, `${name}: ${outcome.summary}`).toBe(true);
      },
    });
    expect(ok).toBe(true);
  });

  describe("schema", () => {
    it("passes one valid record", () => {
      expect(STEERING_RECORD_CHECKS.schema(ctx())).toEqual({
        ok: true,
        summary: "steering-record/v1 valid: 1 file, 1 record",
      });
    });

    it("fails a pull request that changes another path too", () => {
      const out = STEERING_RECORD_CHECKS.schema(ctx({ changedPaths: [RECORD_PATH, "README.md"] }));
      expect(out.ok).toBe(false);
      expect(out.summary).toContain("also changes README.md");
    });

    it("fails a file that does not read, naming the line", () => {
      const text = ctx().fileText.replace("force: should", "force: sometimes");
      const out = STEERING_RECORD_CHECKS.schema(ctx({ fileText: text }));
      expect(out.ok).toBe(false);
      expect(out.summary).toMatch(/^line \d+: /);
    });
  });

  describe("lineage_uniqueness", () => {
    it("passes a lineage no published record holds", () => {
      const out = STEERING_RECORD_CHECKS.lineage_uniqueness(ctx());
      expect(out).toEqual({
        ok: true,
        summary: `no published record holds ${LINEAGE}; this proposal is its only holder`,
      });
    });

    it("passes a revision at the path the published record holds", () => {
      const out = STEERING_RECORD_CHECKS.lineage_uniqueness(
        ctx({ published: { path: RECORD_PATH, version: 3 } }),
      );
      expect(out.ok).toBe(true);
      expect(out.summary).toContain("(version 3)");
    });

    it("passes a first steering record for a lineage published before as TOML", () => {
      const out = STEERING_RECORD_CHECKS.lineage_uniqueness(
        ctx({ published: { path: `.oxagen/rules/${LINEAGE}.toml`, version: 1 } }),
      );
      expect(out.ok).toBe(true);
    });

    it("fails a lineage published at another steering path", () => {
      const other = `steering/facts/${LINEAGE}.md`;
      const out = STEERING_RECORD_CHECKS.lineage_uniqueness(
        ctx({ published: { path: other, version: 2 } }),
      );
      expect(out).toEqual({
        ok: false,
        summary: `${LINEAGE} is already published at ${other}; one lineage, one file`,
      });
    });

    it("fails a file that declares another lineage", () => {
      const out = STEERING_RECORD_CHECKS.lineage_uniqueness(
        ctx({ proposal: { ...ctx().proposal, lineageId: "ctx.release.other" } }),
      );
      expect(out.ok).toBe(false);
      expect(out.summary).toBe(
        `the file declares ${LINEAGE}; the proposal is about ctx.release.other`,
      );
    });

    it("fails a file not named for its lineage", () => {
      const path = "steering/business-rules/changelog.md";
      const out = STEERING_RECORD_CHECKS.lineage_uniqueness(ctx({ path, changedPaths: [path] }));
      expect(out.ok).toBe(false);
      expect(out.summary).toContain(`${path} is not named for ${LINEAGE}`);
    });

    it("fails a path the steering layout does not read as a record", () => {
      const path = `steering/promotions/${LINEAGE}.md`;
      const out = STEERING_RECORD_CHECKS.lineage_uniqueness(ctx({ path, changedPaths: [path] }));
      expect(out.ok).toBe(false);
      expect(out.summary).toContain(`${path} is not a steering record path`);
    });
  });

  describe("record_hash", () => {
    it("passes a file with no id or hash yet", () => {
      const out = STEERING_RECORD_CHECKS.record_hash(ctx());
      expect(out.ok).toBe(true);
      expect(out.summary).toContain("no id or hash yet");
    });

    it("passes a file whose id and hash recompute from its content", () => {
      const stamped = stampRecordText(ctx().fileText);
      if (!stamped.ok) throw new Error(stamped.message);
      const out = STEERING_RECORD_CHECKS.record_hash(ctx({ fileText: stamped.text }));
      expect(out).toEqual({
        ok: true,
        summary: `recomputed over the record: ${stamped.hash} matches the file`,
      });
    });

    it("fails a stamped file whose statement changed after the stamp", () => {
      const stamped = stampRecordText(ctx().fileText);
      if (!stamped.ok) throw new Error(stamped.message);
      const edited = stamped.text.replace("more than once", "twice");
      const out = STEERING_RECORD_CHECKS.record_hash(ctx({ fileText: edited }));
      expect(out.ok).toBe(false);
      expect(out.summary).toContain(`does not match the file's ${stamped.hash}`);
      expect(out.summary).toContain(EDITED_ON_PR);
    });

    it("fails a file with a hash and no id", () => {
      const stamped = stampRecordText(ctx().fileText);
      if (!stamped.ok) throw new Error(stamped.message);
      const out = STEERING_RECORD_CHECKS.record_hash(
        ctx({ fileText: stamped.text.replace(`id: ${stamped.id}\n`, "") }),
      );
      expect(out.ok).toBe(false);
      expect(out.summary).toContain("a hash and no id");
    });
  });

  describe("constraint_effect", () => {
    it("passes a business rule with no effect", () => {
      expect(STEERING_RECORD_CHECKS.constraint_effect(ctx())).toEqual({
        ok: true,
        summary: "business-rule, with no effect. A record grants nothing.",
      });
    });

    it("passes a rule proposal written as a code rule", () => {
      const statement = "Every query on a tenant table goes through withTenantDb(ctx, fn).";
      const text = renderSteeringRecord(heldDraft({ statement, force: "should" }), HELD).text;
      const out = STEERING_RECORD_CHECKS.constraint_effect(
        ctx({
          fileText: text,
          proposal: {
            ...ctx().proposal,
            lineageId: HELD_LINEAGE,
            label: "Tenant queries use withTenantDb",
            sharingScope: "repository",
            statement,
          },
        }),
      );
      expect(out.ok, out.summary).toBe(true);
    });

    it("passes a constraint whose file carries the proposal's effect", () => {
      const text = renderSteeringRecord(
        draft({ kind: "constraint", constraintEffect: "require", force: "must" }),
      ).text;
      const out = STEERING_RECORD_CHECKS.constraint_effect(
        ctx({
          fileText: text,
          path: `steering/constraints/${LINEAGE}.md`,
          proposal: { ...ctx().proposal, kind: "constraint", constraintEffect: "require", force: "must" },
        }),
      );
      expect(out).toEqual({ ok: true, summary: "effect: require. A record grants nothing." });
    });

    it("fails a constraint whose file carries the other effect", () => {
      const text = renderSteeringRecord(
        draft({ kind: "constraint", constraintEffect: "forbid", force: "must" }),
      ).text;
      const out = STEERING_RECORD_CHECKS.constraint_effect(
        ctx({
          fileText: text,
          proposal: { ...ctx().proposal, kind: "constraint", constraintEffect: "require", force: "must" },
        }),
      );
      expect(out.ok).toBe(false);
      expect(out.summary).toContain(`the file's effect is "forbid"; the proposal's is "require"`);
    });

    it("fails a proposal that gives another kind an effect", () => {
      const out = STEERING_RECORD_CHECKS.constraint_effect(
        ctx({ proposal: { ...ctx().proposal, constraintEffect: "forbid" } }),
      );
      expect(out).toEqual({
        ok: false,
        summary: "a business-rule carries no effect; this one carries forbid",
      });
    });

    it("fails a file whose kind, force, scope, statement, or label left the proposal's", () => {
      const text = ctx()
        .fileText.replace("kind: business-rule", "kind: fact")
        .replace("force: should", "force: must")
        .replace("more than once", "twice");
      const out = STEERING_RECORD_CHECKS.constraint_effect(
        ctx({ fileText: text, proposal: { ...ctx().proposal, label: "Another label" } }),
      );
      expect(out.ok).toBe(false);
      expect(out.summary).toContain(`the file's kind is "fact"; the proposal's is "business-rule"`);
      expect(out.summary).toContain(`the file's force is "must"; the proposal's is "should"`);
      expect(out.summary).toContain("the file's statement is");
      expect(out.summary).toContain(`the file's label is "Read the changelog once"`);
      expect(out.summary).toContain(EDITED_ON_PR);
    });
  });
});
