import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentSchema } from "./agent";
import { bundleSchema } from "./bundle";
import {
  encodingIssues,
  readJsonLines,
  readTomlFile,
  type FileIssue,
  type ReadResult,
} from "./files";
import {
  FIXTURE_ROOT,
  fixtureContext,
  fixtureRepo,
  organizationFixtureRepo,
  readFixtureTree,
} from "./fixture-repo";
import { governanceSchema } from "./governance";
import {
  findMentions,
  parseCredentialRef,
  parseToolRef,
  REPO_REF_PATTERN,
  TOOL_SEPARATOR,
  toolName,
  toolTargetMatches,
} from "./names";
import {
  AGENTS_MD_PATH,
  classifySteeringRepoPath,
  CLAUDE_MD_PATH,
  GOVERNANCE_TOML_PATH,
  LEGACY_GOVERNANCE_PATH,
  LEGACY_RULES_DIR,
  LEGACY_WORKSPACE_TOML_PATH,
  README_PATH,
  recordFileName,
  recordLineageFromPath,
  serverTomlPath,
  skillFilePath,
  toolsLockPath,
  WORKSPACE_TOML_PATH,
  type SteeringRepoFileKind,
} from "./paths";
import {
  ledgerChainBreaks,
  promotionSchema,
  type PromotionChange,
  type PromotionLine,
} from "./promotion";
import {
  parseFrontmatter,
  readSteeringRecord,
  recordKindSchema,
  recordStatement,
  splitRecordFile,
  stampRecord,
} from "./record";
import { reflectionSchema } from "./reflection";
import {
  governanceTomlTemplate,
  readManagedBlock,
  workspaceTomlTemplate,
} from "./templates";
import { toolbeltSchema } from "./toolbelt";
import { workspaceSchema } from "./workspace";

type ReadOutcome = { ok: true } | { ok: false; issues: readonly FileIssue[] };

function managedBlockOutcome(text: string): ReadOutcome {
  const read = readManagedBlock(text);
  return read.ok ? { ok: true } : { ok: false, issues: [read.issue] };
}

// The reader for each kind of file this module defines.
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

// The kinds this module has no reader for, and why.
const SKIPPED: Partial<Record<SteeringRepoFileKind, string>> = {
  gitattributes: "it has no format of its own, and templates.test.ts pins its bytes",
  server: "MCP Studio (lane M0) owns the mcp-server/v1 schema and its reader",
  "server-tools": "MCP Studio (lane M0) owns the mcp-tools/v1 schema and its reader",
  "server-lock": "MCP Studio (lane M0) owns the mcp-tools-lock/v1 schema and its reader",
  "server-definition":
    "it is an OpenAPI, overlay, GraphQL, or proto file in its own standard's format",
  "server-test": "it holds the recorded calls a server's tests replay, and this module has no reader for them",
  policy: "it is a Cedar policy, which Cedar's own parser reads",
  "cedar-schema": "it is a Cedar schema, which Cedar's own parser reads",
  "policy-tests": "it holds Cedar policy test cases, and this module has no reader for them",
  "skill-asset": "it is a file a skill links to, with no format of its own",
};

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

function valueOf<T>(read: ReadResult<T>, path: string): T {
  if (!read.ok) throw new Error(`${path} does not read: ${JSON.stringify(read.issues)}`);
  return read.value;
}

function recordOf(text: string, path: string) {
  const read = readSteeringRecord(text);
  if (!read.ok) throw new Error(`${path} does not read: ${JSON.stringify(read.issues)}`);
  return read;
}

/** The frontmatter as written, which is what Oxagen stamps, and the body. */
function frontmatterOf(text: string, path: string) {
  const split = splitRecordFile(text);
  if (!split.ok) throw new Error(`${path} has no frontmatter`);
  const parsed = parseFrontmatter(split.parts.frontmatter);
  if (!parsed.ok) throw new Error(`${path} has unreadable frontmatter`);
  return { value: parsed.frontmatter.value, body: split.parts.body };
}

function isRecordFile(path: string): boolean {
  const kind = classifySteeringRepoPath(path);
  return kind === "record" || kind === "skill-record";
}

const REPOS = [
  { repo: "workspace repo", files: fixtureRepo() },
  { repo: "organization repo", files: organizationFixtureRepo() },
];

const FILES = REPOS.flatMap(({ repo, files }) =>
  [...files].map(([path, text]) => ({
    repo,
    path,
    kind: classifySteeringRepoPath(path),
    text,
  })),
);

describe("the fixture repositories", () => {
  it("gives no kind both a reader and a place on the skip list", () => {
    const skipped = Object.keys(SKIPPED);
    expect(Object.keys(READERS).filter((kind) => skipped.includes(kind))).toEqual([]);
  });

  it.each(REPOS)("gives every path in the $repo a place in the layout", ({ files }) => {
    expect([...files.keys()].filter((path) => classifySteeringRepoPath(path) === "unknown")).toEqual([]);
  });

  it.each(REPOS)("reads or skips every file in the $repo by its kind", ({ files }) => {
    const unhandled = [...files.keys()].filter((path) => {
      const kind = classifySteeringRepoPath(path);
      return READERS[kind] === undefined && SKIPPED[kind] === undefined;
    });
    expect(unhandled).toEqual([]);
  });

  it("holds a file of every kind that is read or skipped in the workspace repo", () => {
    const kinds = new Set([...fixtureRepo().keys()].map(classifySteeringRepoPath));
    const missing = [...Object.keys(READERS), ...Object.keys(SKIPPED)].filter(
      (kind) => !kinds.has(kind as SteeringRepoFileKind),
    );
    expect(missing).toEqual([]);
  });

  it.each(FILES.filter(({ kind }) => READERS[kind] !== undefined))(
    "reads $path in the $repo as a $kind file",
    ({ kind, text }) => {
      expect(readerFor(kind)(text)).toMatchObject({ ok: true });
    },
  );

  it.each(REPOS)("keeps every file in the $repo to the encoding rules", ({ files }) => {
    const broken = [...files].filter(([, text]) => encodingIssues(text).length > 0);
    expect(broken.map(([path]) => path)).toEqual([]);
  });

  it.each(
    REPOS.flatMap(({ repo, files }) =>
      [AGENTS_MD_PATH, CLAUDE_MD_PATH, README_PATH].map((path) => ({
        repo,
        path,
        text: fileOf(files, path),
      })),
    ),
  )("keeps the managed block in $path in the $repo as Oxagen wrote it", ({ text }) => {
    expect(readManagedBlock(text)).toMatchObject({ ok: true, block: { intact: true } });
  });

  it.each(FILES.filter(({ path }) => isRecordFile(path)))(
    "stamps $path in the $repo with the id and hash its content gives, and names it for its lineage",
    ({ path, text }) => {
      const { value, body } = frontmatterOf(text, path);
      expect(stampRecord(value, body)).toEqual({ id: value.id, hash: value.hash });
      expect(recordLineageFromPath(path)).toBe(value.lineage);
    },
  );
});

// ── The ledger ───────────────────────────────────────────────────────────────

function ledgerLines(files: ReadonlyMap<string, string>): PromotionLine[] {
  return [...files]
    .filter(([path]) => classifySteeringRepoPath(path) === "ledger")
    .flatMap(([path, text]) => valueOf(readJsonLines(text, promotionSchema), path));
}

/** The last change the ledger records for each path. */
function latestChanges(files: ReadonlyMap<string, string>): Map<string, PromotionChange> {
  const latest = new Map<string, PromotionChange>();
  for (const line of ledgerLines(files)) {
    for (const change of line.changes) latest.set(change.path, change);
  }
  return latest;
}

describe("the fixture ledgers", () => {
  it.each(REPOS)("chains every line of the $repo's ledger from the first", ({ files }) => {
    const lines = ledgerLines(files);
    expect(lines.length).toBeGreaterThan(0);
    expect(ledgerChainBreaks(lines, null)).toEqual([]);
  });

  it.each(
    REPOS.flatMap(({ repo, files }) =>
      [...latestChanges(files)].map(([path, change]) => ({ repo, path, change, files })),
    ),
  )("leaves $path in the $repo as its last steering PR recorded it", ({ path, change, files }) => {
    if (change.action === "removed") {
      expect(files.has(path)).toBe(false);
      return;
    }
    const text = fileOf(files, path);
    if (!isRecordFile(path)) return;
    const { record } = recordOf(text, path);
    expect(change).toMatchObject({ lineage: record.lineage, id: record.id, hash: record.hash });
  });

  it.each(REPOS)("records every steering record in the $repo in its ledger", ({ files }) => {
    // The test above holds a removed path absent, so a path the ledger holds is present.
    const latest = latestChanges(files);
    expect([...files.keys()].filter((path) => isRecordFile(path) && !latest.has(path))).toEqual([]);
  });

  it.each(REPOS)("records the last steering PR in the $repo in the mode governance.toml sets", ({ files }) => {
    const governance = valueOf(
      readTomlFile(fileOf(files, GOVERNANCE_TOML_PATH), "governance/v1", governanceSchema),
      GOVERNANCE_TOML_PATH,
    );
    expect(ledgerLines(files).at(-1)?.mode).toBe(governance.mode);
  });
});

// ── References ───────────────────────────────────────────────────────────────
//
// The references check resolves names against the repository and against
// what Oxagen knows outside it, which context.json holds for the workspace
// repo.

const workspaceRepo = fixtureRepo();
const context = fixtureContext();

// The part of a server's tools.lock.json read here: the tools it imports.
const lockToolsSchema = z.object({ tools: z.record(z.string(), z.unknown()) });

/** Every tool name the server imports, or none when the server has no lock. */
function importedTools(server: string): string[] {
  const lock = workspaceRepo.get(toolsLockPath(server));
  if (lock === undefined || !workspaceRepo.has(serverTomlPath(server))) return [];
  const { tools } = lockToolsSchema.parse(JSON.parse(lock));
  return Object.keys(tools).map((tool) => toolName(server, tool));
}

/** Does a tool name, or a `<server>__*` target, match a tool some server imports? */
function toolTargetResolves(target: string): boolean {
  const server = target.slice(0, target.indexOf(TOOL_SEPARATOR));
  return importedTools(server).some((name) => toolTargetMatches(target, name));
}

const recordLineages = new Set(
  [...workspaceRepo.keys()]
    .filter((path) => classifySteeringRepoPath(path) === "record")
    .map(recordLineageFromPath),
);

const records = [...workspaceRepo]
  .filter(([path]) => isRecordFile(path))
  .map(([path, text]) => ({ path, text, ...recordOf(text, path) }));

const workspace = valueOf(
  readTomlFile(fileOf(workspaceRepo, WORKSPACE_TOML_PATH), "workspace/v1", workspaceSchema),
  WORKSPACE_TOML_PATH,
);
const linkedRepos = (workspace.repositories ?? []).map(({ url }) => url);

const governance = valueOf(
  readTomlFile(fileOf(workspaceRepo, GOVERNANCE_TOML_PATH), "governance/v1", governanceSchema),
  GOVERNANCE_TOML_PATH,
);

const AGENTS = [...workspaceRepo]
  .filter(([path]) => classifySteeringRepoPath(path) === "agent")
  .map(([path, text]) => ({ path, ...valueOf(readTomlFile(text, "agent/v1", agentSchema), path) }));

const CREDENTIALS = FILES.flatMap(({ repo: name, path, text }) =>
  [...text.matchAll(/oxagen:credential\/[^\s"']*/g)].map(([ref]) => ({ repo: name, path, ref })),
);

const REPO_REFS = records.flatMap(({ path, record }) =>
  (record.repos ?? []).map((target) => ({ path, target })),
);

const SKILL_REFS = records.flatMap(({ path, record }) =>
  (record.skills ?? []).map((target) => ({ path, target })),
);

const TOOL_REFS = [
  ...records.flatMap(({ path, record }) => (record.tools ?? []).map((target) => ({ path, target }))),
  ...[...workspaceRepo]
    .filter(([path]) => classifySteeringRepoPath(path) === "toolbelt")
    .flatMap(([path, text]) =>
      valueOf(readTomlFile(text, "toolbelt/v1", toolbeltSchema), path).tools.map((target) => ({
        path,
        target,
      })),
    ),
];

const MENTIONS = records.flatMap(({ path, body }) =>
  findMentions(body).map(({ kind, target }) => ({ path, kind, target })),
);

// A SKILL.md links a file in its folder as @<file>, such as @assets/logo.svg.
const SKILL_FILE_REFS = records
  .filter(({ path }) => classifySteeringRepoPath(path) === "skill-record")
  .flatMap(({ path, body }) =>
    [...body.matchAll(/@([\w-]+(?:\/[\w-]+)*\.\w+)/g)].map(([, file]) => ({
      path,
      file: `${path.slice(0, path.lastIndexOf("/"))}/${file}`,
    })),
  );

describe("the fixture references", () => {
  // it.each over an empty list runs nothing, so a fixture that lost its
  // references would pass every test below.
  it("finds references of every kind to resolve", () => {
    const counts = {
      agents: AGENTS.length,
      credentials: CREDENTIALS.length,
      groups: (governance.reviewers ?? []).length,
      repos: REPO_REFS.length,
      skills: SKILL_REFS.length,
      tools: TOOL_REFS.length,
      record_mentions: MENTIONS.filter(({ kind }) => kind === "record").length,
      skill_mentions: MENTIONS.filter(({ kind }) => kind === "skill").length,
      tool_mentions: MENTIONS.filter(({ kind }) => kind === "tool").length,
      skill_files: SKILL_FILE_REFS.length,
    };
    expect(Object.entries(counts).filter(([, count]) => count === 0)).toEqual([]);
  });

  it.each(AGENTS)("enrolls the runtime and knows the operator $path names", ({ runtime, operator }) => {
    expect(context.runtimes).toContain(runtime);
    expect([...context.members, ...context.teams]).toContain(operator);
  });

  it.each(CREDENTIALS)("holds $ref, which $path in the $repo names, in the vault", ({ ref }) => {
    const name = parseCredentialRef(ref);
    expect(name).not.toBeNull();
    expect(context.credentials).toContain(name);
  });

  it.each(governance.reviewers ?? [])("knows the reviewer group $group", ({ group }) => {
    expect(context.groups).toContain(group);
  });

  it.each(REPO_REFS)("links $target, which $path names, in workspace.toml", ({ target }) => {
    expect(linkedRepos).toContain(target);
  });

  it.each(SKILL_REFS)("defines the skill $target, which $path names", ({ target }) => {
    expect(classifySteeringRepoPath(skillFilePath(target))).toBe("skill-record");
    expect(workspaceRepo.has(skillFilePath(target))).toBe(true);
  });

  it.each(TOOL_REFS)("imports a tool that $target, which $path names, matches", ({ target }) => {
    expect(toolTargetResolves(target)).toBe(true);
  });

  it.each(MENTIONS)("resolves the @$kind: mention of $target in $path", ({ kind, target }) => {
    if (kind === "record") {
      expect(recordLineages.has(target)).toBe(true);
    } else if (kind === "skill") {
      expect(workspaceRepo.has(skillFilePath(target))).toBe(true);
    } else {
      const ref = parseToolRef(target);
      expect(ref).not.toBeNull();
      expect(importedTools(ref?.server ?? "")).toContain(target);
    }
  });

  it.each(SKILL_FILE_REFS)("holds $file, which $path links", ({ file }) => {
    expect(workspaceRepo.has(file)).toBe(true);
    expect(classifySteeringRepoPath(file)).toBe("skill-asset");
  });
});

// ── Stored files ─────────────────────────────────────────────────────────────

// The schema each file in stored/ follows.
const STORED: Record<string, z.ZodTypeAny> = {
  "bundle.json": bundleSchema,
  "reflection-clean.json": reflectionSchema,
  "reflection.json": reflectionSchema,
};

describe("the stored fixtures", () => {
  const stored = readFixtureTree(join(FIXTURE_ROOT, "stored"));

  it("holds a schema here for every file in stored/", () => {
    expect([...stored.keys()].sort()).toEqual(Object.keys(STORED).sort());
  });

  it.each(Object.entries(STORED))("parses %s with its schema", (name, schema) => {
    const value: unknown = JSON.parse(fileOf(stored, name));
    expect(schema.safeParse(value)).toMatchObject({ success: true });
  });
});

// ── The v0.1 conversion ──────────────────────────────────────────────────────

const legacyRecordSchema = z
  .object({
    lineage_id: z.string(),
    label: z.string(),
    record_id: z.string(),
    record_hash: z.string(),
    kind: z.string(),
    statement: z.string(),
    origin: z.string(),
    sharing_scope: z.string(),
    status: z.string(),
    constraint_effect: z.string().optional(),
    provenance: z.object({ source_kind: z.string(), source_uri: z.string() }).strict(),
    steering: z.object({ force: z.string() }).strict(),
  })
  .strict();

// A v0.1 rules file holds one record.
const legacyRecordFileSchema = z
  .object({
    schema: z.literal("context-record/v0.1"),
    set_id: z.string(),
    record: z.tuple([legacyRecordSchema]),
  })
  .strict();

const legacyWorkspaceSchema = z
  .object({
    workspace: z.object({ organization: z.string(), slug: z.string(), name: z.string() }).strict(),
    repository: z
      .object({ name: z.string(), role: z.string(), production_branch: z.string() })
      .strict(),
  })
  .strict();

const legacyGovernanceSchema = z
  .object({ mode: z.string(), separation_of_duties: z.boolean() })
  .strict();

const conversionSchema = z
  .object({
    note: z.string(),
    set_id: z.string(),
    folder: z.string(),
    records: z
      .array(
        z
          .object({
            from: z.string(),
            old_lineage: z.string(),
            old_id: z.string(),
            to: z.string(),
            lineage: z.string(),
            kind: recordKindSchema,
            id: z.string(),
          })
          .strict(),
      )
      .min(1),
    dropped: z.record(z.string(), z.array(z.string())),
    relinked: z.string(),
  })
  .strict();

// The keys of each v0.1 settings file that v1 keeps: the mode goes to
// steering/governance.toml, and the organization, slug, and repository go to
// workspace.toml.
const CARRIED: Record<string, string[]> = {
  [LEGACY_GOVERNANCE_PATH]: ["mode"],
  [LEGACY_WORKSPACE_TOML_PATH]: ["workspace.organization", "workspace.slug", "repository.name"],
};

/** Every leaf key of a TOML table, dot-joined. */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, inner]) =>
    leafKeys(inner, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("the v0.1 conversion", () => {
  const root = join(FIXTURE_ROOT, "v0.1");
  const input = readFixtureTree(join(root, "input"));
  const expected = readFixtureTree(join(root, "expected"));
  const conversion = conversionSchema.parse(
    JSON.parse(fileOf(readFixtureTree(root), "conversion.json")),
  );
  const legacyWorkspace = legacyWorkspaceSchema.parse(
    parseToml(fileOf(input, LEGACY_WORKSPACE_TOML_PATH)),
  );
  const legacyGovernance = legacyGovernanceSchema.parse(
    parseToml(fileOf(input, LEGACY_GOVERNANCE_PATH)),
  );

  it("converts every v0.1 rules file, and the input holds nothing else but the two settings files", () => {
    expect([...input.keys()].sort()).toEqual(
      [
        ...conversion.records.map(({ from }) => from),
        LEGACY_GOVERNANCE_PATH,
        LEGACY_WORKSPACE_TOML_PATH,
      ].sort(),
    );
    for (const { from } of conversion.records) expect(from.startsWith(`${LEGACY_RULES_DIR}/`)).toBe(true);
  });

  it("expects one file per converted record, and the two settings files", () => {
    expect([...expected.keys()].sort()).toEqual(
      [...conversion.records.map(({ to }) => to), GOVERNANCE_TOML_PATH, WORKSPACE_TOML_PATH].sort(),
    );
  });

  it.each([...expected].map(([path, text]) => ({ path, text, kind: classifySteeringRepoPath(path) })))(
    "reads $path in the expected tree as a $kind file",
    ({ kind, text }) => {
      expect(readerFor(kind)(text)).toMatchObject({ ok: true });
    },
  );

  it.each(conversion.records)("converts $from to $to", (entry) => {
    const legacy = legacyRecordFileSchema.parse(parseToml(fileOf(input, entry.from)));
    const [old] = legacy.record;
    expect(legacy.set_id).toBe(conversion.set_id);
    expect({ lineage: old.lineage_id, id: old.record_id }).toEqual({
      lineage: entry.old_lineage,
      id: entry.old_id,
    });

    // The lineage drops ctx.<org>. and takes the set id as its prefix.
    expect(entry.old_lineage).toMatch(/^ctx\.[^.]+\./);
    expect(entry.lineage).toBe(
      `${conversion.set_id}.${entry.old_lineage.split(".").slice(2).join(".")}`,
    );
    expect(entry.to).toBe(`${conversion.folder}/${recordFileName(entry.lineage)}`);

    // A v0.1 rule became a business or code rule by a person's choice. Every
    // other kind kept its name.
    const kinds = old.kind === "rule" ? ["business-rule", "code-rule"] : [old.kind];
    expect(kinds).toContain(entry.kind);

    const text = fileOf(expected, entry.to);
    const { record, body } = recordOf(text, entry.to);
    expect(record).toMatchObject({
      lineage: entry.lineage,
      kind: entry.kind,
      id: entry.id,
      label: old.label,
      force: old.steering.force,
      scope: old.sharing_scope,
      status: old.status,
      origin: old.origin,
      provenance: { source: old.provenance.source_kind, uri: old.provenance.source_uri },
    });
    expect(record.effect).toBe(old.constraint_effect);
    expect(recordStatement(body)).toBe(old.statement);

    const frontmatter = frontmatterOf(text, entry.to);
    expect(stampRecord(frontmatter.value, frontmatter.body)).toEqual({
      id: entry.id,
      hash: record.hash,
    });
  });

  it("drops keys only from the two settings files", () => {
    expect(Object.keys(conversion.dropped).sort()).toEqual(Object.keys(CARRIED).sort());
  });

  it.each(Object.entries(CARRIED))("keeps or drops every key of %s", (path, carried) => {
    expect(leafKeys(parseToml(fileOf(input, path))).sort()).toEqual(
      [...carried, ...(conversion.dropped[path] ?? [])].sort(),
    );
  });

  it("writes the v0.1 mode into a new repository's governance.toml", () => {
    expect(fileOf(expected, GOVERNANCE_TOML_PATH)).toBe(
      governanceTomlTemplate().replace('mode = "solo"', `mode = ${JSON.stringify(legacyGovernance.mode)}`),
    );
  });

  it("writes the v0.1 workspace into a new repository's workspace.toml, and links the repository", () => {
    const { organization, slug } = legacyWorkspace.workspace;
    expect(conversion.relinked).toMatch(REPO_REF_PATTERN);
    expect(conversion.relinked.endsWith(`/${legacyWorkspace.repository.name}`)).toBe(true);
    expect(fileOf(expected, WORKSPACE_TOML_PATH)).toBe(
      `${workspaceTomlTemplate(organization, slug)}\n[[repositories]]\nurl = ${JSON.stringify(conversion.relinked)}\n`,
    );
  });
});
