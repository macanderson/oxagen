import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentSchema } from "./agent";
import { readJsonLines, readTomlFile, type FileIssue } from "./files";
import {
  FIXTURE_CHECKS,
  FIXTURE_ROOT,
  fixtureRepo,
  invalidCases,
  invalidCaseSchema,
} from "./fixture-repo";
import { governanceSchema } from "./governance";
import { classifySteeringRepoPath, type SteeringRepoFileKind } from "./paths";
import { promotionSchema } from "./promotion";
import { readSteeringRecord } from "./record";
import { readManagedBlock } from "./templates";
import { toolbeltSchema } from "./toolbelt";
import { workspaceSchema } from "./workspace";

type ReadOutcome = { ok: true } | { ok: false; issues: readonly FileIssue[] };

function managedBlockOutcome(text: string): ReadOutcome {
  const read = readManagedBlock(text);
  return read.ok ? { ok: true } : { ok: false, issues: [read.issue] };
}

// The reader for each kind of file this module defines. A kind with no entry
// has no reader here, so only a later check of the steering PR can refuse it.
const READERS: Partial<Record<SteeringRepoFileKind, (text: string) => ReadOutcome>> = {
  "agents-md": managedBlockOutcome,
  "claude-md": managedBlockOutcome,
  readme: managedBlockOutcome,
  workspace: (text) => readTomlFile(text, "workspace/v1", workspaceSchema),
  governance: (text) => readTomlFile(text, "governance/v1", governanceSchema),
  agent: (text) => readTomlFile(text, "agent/v1", agentSchema),
  toolbelt: (text) => readTomlFile(text, "toolbelt/v1", toolbeltSchema),
  ledger: (text) => readJsonLines(text, promotionSchema),
  record: readSteeringRecord,
  "skill-record": readSteeringRecord,
};

/** Is this a file whose content Oxagen writes between managed-block markers? */
function isManagedFile(path: string): boolean {
  return READERS[classifySteeringRepoPath(path)] === managedBlockOutcome;
}

function readerFor(kind: SteeringRepoFileKind): (text: string) => ReadOutcome {
  const reader = READERS[kind];
  if (reader === undefined) throw new Error(`no reader for ${kind}`);
  return reader;
}

function fileOf(files: ReadonlyMap<string, string>, path: string): string {
  const text = files.get(path);
  if (text === undefined) throw new Error(`${path} is missing`);
  return text;
}

const INVALID_ROOT = join(FIXTURE_ROOT, "invalid");
const base = fixtureRepo();
const CASES = invalidCases();
const REFUSED = CASES.filter((c) => c.refused_by_reader);
const PASSING = CASES.filter((c) => !c.refused_by_reader);

describe("the invalid cases", () => {
  it("has cases the readers refuse and cases they pass", () => {
    expect(REFUSED.length).toBeGreaterThan(0);
    expect(PASSING.length).toBeGreaterThan(0);
  });

  it("gives every case its own id", () => {
    const ids = CASES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("holds a case for every check a steering PR runs, and a folder only for those checks", () => {
    expect(FIXTURE_CHECKS.filter((check) => !CASES.some((c) => c.check === check))).toEqual([]);
    expect(readdirSync(INVALID_ROOT).sort()).toEqual([...FIXTURE_CHECKS].sort());
  });

  it.each(CASES)("parses the case.json of $id and files it under its check", ({ id, check }) => {
    const manifest: unknown = JSON.parse(readFileSync(join(INVALID_ROOT, id, "case.json"), "utf8"));
    expect(invalidCaseSchema.safeParse(manifest)).toMatchObject({ success: true });
    expect(id).toMatch(new RegExp(`^${check}/[a-z0-9-]+$`));
  });

  it.each(CASES)("builds $id from repo/ with only the case's changes", (c) => {
    expect(c.changed.filter((path) => c.removed.includes(path))).toEqual([]);
    expect(c.removed.filter((path) => !base.has(path) || c.files.has(path))).toEqual([]);
    expect(c.changed.filter((path) => c.files.get(path) === base.get(path))).toEqual([]);
    expect(c.changed.filter((path) => classifySteeringRepoPath(path) === "unknown")).toEqual([]);
    expect(
      [...base].filter(
        ([path, text]) =>
          !c.changed.includes(path) && !c.removed.includes(path) && c.files.get(path) !== text,
      ),
    ).toEqual([]);
    expect([...c.files.keys()].filter((path) => !base.has(path) && !c.changed.includes(path))).toEqual([]);
  });

  // A settings case describes the host's repository settings, not a file.
  it.each(CASES)("changes files in $id, or reports host settings when it is a settings case", (c) => {
    const settingsCase = c.check === "settings";
    expect(c.actual_settings !== undefined).toBe(settingsCase);
    expect(c.changed.length + c.removed.length > 0).toBe(!settingsCase);
    expect(c.expect.filter(({ path }) => c.files.has(path) === settingsCase)).toEqual([]);
  });
});

describe("the cases the readers refuse", () => {
  it.each(REFUSED)("points every finding in $id at a file the case changes", (c) => {
    expect(c.expect.filter(({ path }) => !c.changed.includes(path))).toEqual([]);
  });

  it.each(
    REFUSED.flatMap((c) => c.expect.map((finding) => ({ id: c.id, files: c.files, ...finding }))),
  )("refuses $path in $id at the line and field case.json gives", ({ files, path, line, field }) => {
    const read = readerFor(classifySteeringRepoPath(path))(fileOf(files, path));
    expect(read).toMatchObject({ ok: false });
    const where = {
      ...(line === undefined ? {} : { line }),
      ...(field === undefined ? {} : { field }),
    };
    expect(read.ok ? [] : read.issues).toContainEqual(expect.objectContaining(where));
  });
});

describe("the cases a later check refuses", () => {
  it.each(
    PASSING.flatMap((c) =>
      c.changed
        .map((path) => ({ id: c.id, path, kind: classifySteeringRepoPath(path), text: fileOf(c.files, path) }))
        .filter(({ kind }) => READERS[kind] !== undefined),
    ),
  )("reads $path in $id as a $kind file", ({ kind, text }) => {
    expect(readerFor(kind)(text)).toMatchObject({ ok: true });
  });

  // The owned check refuses an edit to a file Oxagen writes. For a managed
  // file, the edit shows as a block that no longer matches its hash, or no
  // block at all.
  it.each(
    PASSING.filter((c) => c.check === "owned").flatMap((c) =>
      c.changed
        .filter(isManagedFile)
        .map((path) => ({ id: c.id, path, text: fileOf(c.files, path) })),
    ),
  )("finds the managed block in $path edited or gone in $id", ({ text }) => {
    const read = readManagedBlock(text);
    expect(read.ok && read.block?.intact !== true).toBe(true);
  });
});
