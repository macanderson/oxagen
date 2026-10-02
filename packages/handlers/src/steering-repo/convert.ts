// steering-repo/convert.ts: the conversion that moves a workspace's steering
// out of `.oxagen/` in the repository it used to bind and into its steering
// repo (steering spec, Workspace migration). The handler for
// import_workspace_steering is ../steering_repo.import.ts, and the run is
// ./import-run.ts.
//
// `convertOxagenTree` is pure. It reads the old `.oxagen/` tree and answers
// every file the import steering PRs write, every path the cleanup PR
// removes, and everything it could not carry over, with the reason.
//
// The conversion follows packages/oxagen/fixtures/steering-repo/v0.1/:
//   - Each v0.1 record becomes steering/imported/<lineage>.md. The lineage
//     drops `ctx.<set>.` and takes the workspace's set id as its prefix.
//   - The records, skills, and governance.toml go in import batches of at
//     most 299 files each: steering/import-oxagen, then
//     steering/import-oxagen-2, and so on. Each batch commits
//     steering/imported/replaces.txt, which names each converted record's old
//     id, so the stamp writes it as `replaces`.
//   - A record whose record_id is missing or is not a record id waits for a
//     person. The stamp refuses an imported record with no old id, and its
//     runs could not follow it to the new file.
//   - A v0.1 `rule` becomes a business-rule or a code-rule. A person chooses,
//     so a rule with no choice waits, as does a constraint with no effect.
//   - Each skill under .oxagen/skills/ becomes steering/skills/<lineage>/.
//   - .oxagen/rules/governance.toml keeps its mode in steering/governance.toml.
//     A missing file meant team, so the import writes team.
//   - workspace.toml lists the old repository as a linked repository.
//   - An agent becomes agents/<lineage>.toml only when Oxagen holds its
//     operator, runtime, and harness. Every other agent is placed by hand.
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { stringify } from "yaml";
import type { GovernanceMode } from "@oxagen/oxagen/contracts/context.steering.shared";
import { fitSteeringRecordLabel } from "@oxagen/oxagen/steering-record-label";
import { readSkillFrontmatter } from "@oxagen/oxagen/skill-frontmatter";
import { agentSchema } from "@oxagen/oxagen/steering-repo/agent";
import {
  lineageSchema,
  recordIdSchema,
} from "@oxagen/oxagen/steering-repo/common";
import { readTomlFile } from "@oxagen/oxagen/steering-repo/files";
import { governanceSchema } from "@oxagen/oxagen/steering-repo/governance";
import {
  agentFilePath,
  GOVERNANCE_TOML_PATH,
  LEGACY_GOVERNANCE_PATH,
  LEGACY_KEEP_FILES,
  LEGACY_OXAGEN_DIR,
  LEGACY_RECORD_SCHEMA,
  LEGACY_RULES_DIR,
  LEGACY_SKILLS_DIR,
  LEGACY_WORKSPACE_TOML_PATH,
  skillFilePath,
  skillFolderPath,
  WORKSPACE_LINK_PATH,
  WORKSPACE_TOML_PATH,
} from "@oxagen/oxagen/steering-repo/paths";
import {
  readSteeringRecord,
  recordEffectSchema,
  recordForceSchema,
  stampRecord,
  STEERING_RECORD_FIELDS,
  type RecordEffect,
  type RecordKind,
} from "@oxagen/oxagen/steering-repo/record";
import { schemaDirective } from "@oxagen/oxagen/steering-repo/schema-ids";
import {
  governanceTomlTemplate,
  workspaceTomlTemplate,
} from "@oxagen/oxagen/steering-repo/templates";
import { parseGovernanceMode } from "../context.steering.policy";
import { memoryLabel } from "../memory/naming";
import {
  newWorkspaceToml,
  readWorkspaceToml,
  withRepository,
} from "../repository.workspace-toml";
import {
  branchScopeRefusal,
  IMPORT_BRANCH,
  IMPORT_RECORDS_DIR,
  IMPORT_REPLACES_PATH,
  importBranch,
  isImportBranch,
  renderReplacesFile,
  STEERING_PR_MAX_FILES,
} from "./stamp";

// ── Names ────────────────────────────────────────────────────────────────────

/** The branch of the steering PR that imports workspace.toml. */
export const IMPORT_WORKSPACE_BRANCH = "workspace/import-oxagen";

/** The branch of the steering PR that imports one agent: `agents/<lineage>`. */
export function importAgentBranch(name: string): string {
  return `agents/${name}`;
}

/** The machine-local files under .oxagen/ that stay in a code checkout. */
const MACHINE_LOCAL_FILES: ReadonlySet<string> = new Set([
  WORKSPACE_LINK_PATH,
  `${LEGACY_OXAGEN_DIR}/settings.json`,
  `${LEGACY_OXAGEN_DIR}/settings.local.json`,
]);

/** Agent files from before ADR-198. Nothing reads them, so the cleanup removes them. */
const LEGACY_AGENTS_DIR = `${LEGACY_OXAGEN_DIR}/agents`;

const LEGACY_LINEAGE = /^ctx\.[^.]+\.(.+)$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_DESCRIPTION_MAX = 1024;
const AGENT_LABEL_MAX = 80;

// ── Input and output ─────────────────────────────────────────────────────────

/** The kind a person chooses for a v0.1 rule. */
export type RuleKind = "business-rule" | "code-rule";

/** An agent as Oxagen holds it. A null field is one Oxagen does not know. */
export interface ImportAgent {
  slug: string;
  label: string;
  operator: string | null;
  runtime: string | null;
  harness: string | null;
}

export interface OxagenTreeInput {
  /** Every committed file under .oxagen/ on the old repository's production branch, by path. */
  files: ReadonlyMap<string, string>;
  organization: string;
  workspace: string;
  /** The old repository as workspace.toml lists it, such as github.com/a-intel/platform. */
  relinked: string;
  /** The kind of each v0.1 rule, by its old lineage. */
  ruleKinds?: Readonly<Record<string, RuleKind>>;
  /** The effect of each v0.1 constraint whose file names none, by its old lineage. */
  constraintEffects?: Readonly<Record<string, RecordEffect>>;
  /** workspace.toml on the steering repo's default branch. Null when it has none. */
  workspaceToml?: string | null;
  /** steering/governance.toml on the steering repo's default branch. Null when it has none. */
  governanceToml?: string | null;
  /** The workspace's agents. */
  agents?: readonly ImportAgent[];
}

/** One file an import steering PR writes. */
export interface ImportFile {
  path: string;
  content: string;
}

/** One import steering PR: its branch, the files it writes, and the records it converts. */
export interface ImportBranch {
  branch: string;
  files: ImportFile[];
  /** The v0.1 records this PR converts. Empty on every branch but an import batch. */
  records: ImportedRecord[];
}

/** One v0.1 record the import converts, with its id before and after. */
export interface ImportedRecord {
  from: string;
  old_lineage: string;
  /** The v0.1 record_id. The stamp writes it as the record's `replaces`. */
  old_id: string;
  to: string;
  lineage: string;
  kind: RecordKind;
  id: string;
}

/** A path, or a record in a file, that the import leaves for a person. */
export interface Unconverted {
  path: string;
  /** The v0.1 lineage, for a record inside a rule file. */
  lineage?: string;
  reason: string;
}

/** An agent the import leaves for a person to write in agents/. */
export interface AgentByHand {
  name: string;
  reason: string;
}

export interface OxagenTreeConversion {
  /** The set id every imported lineage starts with: `<organization>.<workspace>`. */
  set: string;
  /**
   * The import steering PRs: the import batches in order, then
   * workspace/import-oxagen, then one agents/ PR per agent. A PR with nothing
   * to write is left out.
   */
  branches: ImportBranch[];
  records: ImportedRecord[];
  /** Each imported record's old id, by its new path. Each batch's replaces file holds its own records. */
  replaces: Map<string, string>;
  skills: { from: string; to: string; lineage: string }[];
  governanceMode: GovernanceMode;
  /** The keys the new files have no place for, by the file that held them. */
  dropped: Record<string, string[]>;
  /** The paths the cleanup PR removes from the old repository, sorted. */
  cleanupPaths: string[];
  /** Files and records the import leaves for a person. */
  unconverted: Unconverted[];
  /** Old lineages of the v0.1 rules that need a kind before the import can run. */
  rulesNeedingKind: string[];
  /** Old lineages of the v0.1 constraints that need an effect before the import can run. */
  constraintsNeedingEffect: string[];
  agentsByHand: AgentByHand[];
}

export type ImportRefusalReason =
  | "workspace_mismatch"
  | "governance_unreadable"
  | "workspace_toml_unreadable"
  | "too_many_files"
  | "branch_scope";

export type OxagenTreeResult =
  | { ok: true; conversion: OxagenTreeConversion }
  | { ok: false; reason: ImportRefusalReason; message: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Every leaf key of a parsed TOML table, dotted, in file order. */
function leafKeys(table: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(table)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isRecord(value)) keys.push(...leafKeys(value, path));
    else keys.push(path);
  }
  return keys;
}

/** The statement as a record body holds it: LF line endings, trimmed. */
function normalizeStatement(statement: string): string {
  return statement.replace(/\r\n?/g, "\n").trim();
}

/**
 * A steering record with its `id` and `hash` already written, so the stamp at
 * merge leaves the file as it is. The fields go in the order the schema
 * lists them, as Oxagen writes every record. Throws when the file would not
 * read as a steering record.
 */
function renderImportedRecord(
  fields: Record<string, unknown>,
  statement: string,
): { text: string; id: string } {
  const { id, hash } = stampRecord(fields, statement);
  const all: Record<string, unknown> = { ...fields, id, hash };
  const ordered: Record<string, unknown> = {};
  for (const field of STEERING_RECORD_FIELDS) {
    if (all[field] !== undefined) ordered[field] = all[field];
  }
  // A record refuses anchors and aliases, and a folded line would hide a value's end.
  const yaml = stringify(ordered, { aliasDuplicateObjects: false, lineWidth: 0 });
  const rendered = `---\n${yaml}---\n\n${statement}\n`;
  const read = readSteeringRecord(rendered);
  if (!read.ok) {
    throw new Error(
      `[steering_repo.import] ${String(fields.lineage)} does not read as a steering record: ${read.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return { text: rendered, id };
}

function addDropped(
  dropped: Record<string, string[]>,
  path: string,
  keys: readonly string[],
): void {
  if (keys.length === 0) return;
  const held = dropped[path] ?? [];
  for (const key of keys) if (!held.includes(key)) held.push(key);
  dropped[path] = held;
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// ── Records ──────────────────────────────────────────────────────────────────

/** The v0.1 keys the conversion reads. Any other key in a record is dropped. */
const LEGACY_RECORD_KEYS = new Set([
  "lineage_id",
  "label",
  "record_id",
  "record_hash",
  "kind",
  "statement",
  "origin",
  "sharing_scope",
  "status",
  "constraint_effect",
  "provenance",
  "steering",
]);

const LEGACY_KINDS: ReadonlySet<string> = new Set([
  "constraint",
  "procedure",
  "fact",
  "memory",
  "preference",
]);

interface RecordContext {
  set: string;
  relinked: string;
  ruleKinds: Readonly<Record<string, RuleKind>>;
  constraintEffects: Readonly<Record<string, RecordEffect>>;
}

type RecordConversion =
  | { kind: "converted"; lineage: string; recordKind: RecordKind; text: string; id: string; oldId: string; dropped: string[] }
  | { kind: "needs_kind" }
  | { kind: "needs_effect" }
  | { kind: "unconverted"; reason: string };

/** One `[[record]]` of a v0.1 file as a v1 steering record. */
function convertRecord(
  path: string,
  oldLineage: string,
  raw: Record<string, unknown>,
  ctx: RecordContext,
): RecordConversion {
  const match = LEGACY_LINEAGE.exec(oldLineage);
  if (!match) {
    return {
      kind: "unconverted",
      reason: `the lineage ${oldLineage} does not start with ctx.<set>.`,
    };
  }
  const lineage = `${ctx.set}.${match[1] as string}`;
  if (!lineageSchema.safeParse(lineage).success) {
    return { kind: "unconverted", reason: `${lineage} is not a lineage` };
  }
  // The stamp refuses an imported record without its old id, because the
  // runs that cite the old id would lose the record.
  const oldId = text(raw, "record_id");
  if (oldId === null || !recordIdSchema.safeParse(oldId).success) {
    return {
      kind: "unconverted",
      reason: `the record_id ${JSON.stringify(oldId)} is not a record id, so its runs cannot follow the record`,
    };
  }

  const dropped = Object.keys(raw)
    .filter((key) => !LEGACY_RECORD_KEYS.has(key))
    .map((key) => `record.${key}`);

  const legacyKind = text(raw, "kind");
  let recordKind: RecordKind;
  if (legacyKind === "rule") {
    const chosen = ctx.ruleKinds[oldLineage];
    if (!chosen) return { kind: "needs_kind" };
    recordKind = chosen;
  } else if (legacyKind !== null && LEGACY_KINDS.has(legacyKind)) {
    recordKind = legacyKind as RecordKind;
  } else {
    return {
      kind: "unconverted",
      reason: `the kind ${JSON.stringify(legacyKind)} has no v1 kind`,
    };
  }

  const statement = normalizeStatement(text(raw, "statement") ?? "");
  if (statement === "") {
    return { kind: "unconverted", reason: "the record has no statement" };
  }

  const steering = isRecord(raw.steering) ? raw.steering : {};
  const force = recordForceSchema.safeParse(steering.force);
  if (!force.success) {
    return {
      kind: "unconverted",
      reason: `the force ${JSON.stringify(steering.force)} is not must, should, may, or info`,
    };
  }

  let effect: RecordEffect | undefined;
  const fileEffect = recordEffectSchema.safeParse(raw.constraint_effect);
  if (recordKind === "constraint") {
    effect = fileEffect.success
      ? fileEffect.data
      : ctx.constraintEffects[oldLineage];
    if (!effect) return { kind: "needs_effect" };
  } else if (raw.constraint_effect !== undefined) {
    dropped.push("record.constraint_effect");
  }

  const sharing = text(raw, "sharing_scope");
  if (sharing !== "workspace" && sharing !== "repository") {
    return {
      kind: "unconverted",
      reason: `the sharing scope ${JSON.stringify(sharing)} is not workspace or repository`,
    };
  }
  const origin = text(raw, "origin") ?? "user";
  if (origin !== "user" && origin !== "inferred") {
    return {
      kind: "unconverted",
      reason: `the origin ${JSON.stringify(origin)} is not user or inferred`,
    };
  }
  const status = text(raw, "status") ?? "active";
  if (status !== "active" && status !== "archived") {
    return {
      kind: "unconverted",
      reason: `the status ${JSON.stringify(status)} is not active or archived`,
    };
  }

  const provenance = isRecord(raw.provenance) ? raw.provenance : {};
  const sourceKind = text(provenance, "source_kind");
  const sourceUri = text(provenance, "source_uri");
  const label = text(raw, "label");

  const fields: Record<string, unknown> = {
    schema: "steering-record/v1",
    lineage,
    label: label ? fitSteeringRecordLabel(label) : memoryLabel(statement),
    kind: recordKind,
    effect,
    force: force.data,
    scope: sharing,
    repos: sharing === "repository" ? [ctx.relinked] : undefined,
    status,
    origin,
    provenance: {
      source: sourceKind === "proposal" ? "proposal" : "import",
      uri: sourceUri ?? `${ctx.relinked}/${path}`,
    },
  };
  const rendered = renderImportedRecord(fields, statement);
  return {
    kind: "converted",
    lineage,
    recordKind,
    text: rendered.text,
    id: rendered.id,
    oldId,
    dropped,
  };
}

/** The `[[record]]` tables of a v0.1 file, or why the file is not one. */
function readLegacyRecordFile(
  source: string,
): { ok: true; records: Record<string, unknown>[]; dropped: string[] } | { ok: false; reason: string } {
  let tree: unknown;
  try {
    tree = parseToml(source);
  } catch (error) {
    return {
      ok: false,
      reason: `the file is not TOML: ${error instanceof Error ? (error.message.split("\n", 1)[0] as string) : String(error)}`,
    };
  }
  if (!isRecord(tree) || tree.schema !== LEGACY_RECORD_SCHEMA) {
    return { ok: false, reason: `the file is not ${LEGACY_RECORD_SCHEMA}` };
  }
  const records = tree.record;
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: "the file holds no [[record]]" };
  }
  const dropped = Object.keys(tree).filter(
    (key) => key !== "schema" && key !== "set_id" && key !== "record",
  );
  return {
    ok: true,
    records: records.map((record) => (isRecord(record) ? record : {})),
    dropped,
  };
}

// ── Skills ───────────────────────────────────────────────────────────────────

/** True for text that did not come through as UTF-8, such as an image. */
function looksBinary(content: string): boolean {
  return content.includes("\u0000") || content.includes("�");
}

/** A skill's name as a label: `write-migration` reads "Write migration". */
function skillLabel(name: string): string {
  const words = name.replace(/-+/g, " ").trim();
  return fitSteeringRecordLabel(
    words.charAt(0).toUpperCase() + words.slice(1),
  );
}

type SkillConversion =
  | { ok: true; text: string; dropped: string[] }
  | { ok: false; reason: string };

function convertSkill(
  path: string,
  name: string,
  source: string,
  set: string,
  relinked: string,
): SkillConversion {
  const frontmatter = readSkillFrontmatter(source);
  if (!frontmatter) {
    return { ok: false, reason: "SKILL.md has no readable frontmatter" };
  }
  const description = normalizeStatement(
    frontmatter.fields.description ?? "",
  ).replace(/\s+/g, " ");
  if (description === "") {
    return { ok: false, reason: "SKILL.md names no description" };
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return {
      ok: false,
      reason: `the description is longer than ${SKILL_DESCRIPTION_MAX} characters`,
    };
  }
  const body = normalizeStatement(
    source
      .replace(/\r\n/g, "\n")
      .split("\n")
      .slice(frontmatter.bodyStart)
      .join("\n"),
  );
  if (body === "") return { ok: false, reason: "SKILL.md has no body" };
  const fields: Record<string, unknown> = {
    schema: "steering-record/v1",
    lineage: `${set}.${name}`,
    label: skillLabel(name),
    description,
    kind: "skill",
    name,
    force: "may",
    scope: "workspace",
    status: "active",
    origin: "user",
    provenance: { source: "import", uri: `${relinked}/${path}` },
  };
  const dropped = Object.keys(frontmatter.fields)
    .filter((key) => key !== "name" && key !== "description")
    .map((key) => `frontmatter.${key}`);
  return { ok: true, text: renderImportedRecord(fields, body).text, dropped };
}

// ── Governance and workspace.toml ────────────────────────────────────────────

type FileResult =
  | { ok: true; content: string | null }
  | { ok: false; reason: ImportRefusalReason; message: string };

/**
 * steering/governance.toml with the old mode, or null when the file on the
 * steering repo already says it. A file that reads keeps every other line.
 */
function governanceFile(
  mode: GovernanceMode,
  current: string | null,
): FileResult {
  const modeLine = `mode = ${JSON.stringify(mode)}`;
  let next = governanceTomlTemplate().replace(/^mode = .*$/m, modeLine);
  if (current !== null) {
    const read = readTomlFile(current, "governance/v1", governanceSchema);
    if (read.ok) {
      if (read.value.mode === mode) return { ok: true, content: null };
      next = current.replace(/^mode\s*=.*$/m, modeLine);
    }
  }
  const check = readTomlFile(next, "governance/v1", governanceSchema);
  if (!check.ok || check.value.mode !== mode) {
    return {
      ok: false,
      reason: "governance_unreadable",
      message: `${GOVERNANCE_TOML_PATH} with mode ${mode} does not read as governance/v1`,
    };
  }
  return { ok: true, content: next };
}

/** workspace.toml listing the old repository, or null when it already does. */
function workspaceFile(input: OxagenTreeInput): FileResult {
  const current =
    input.workspaceToml === undefined
      ? workspaceTomlTemplate(input.organization, input.workspace)
      : input.workspaceToml;
  const read = readWorkspaceToml(current);
  switch (read.kind) {
    case "missing":
      return {
        ok: true,
        content: newWorkspaceToml(input.organization, input.workspace, input.relinked),
      };
    case "foreign":
    case "unreadable":
      return {
        ok: false,
        reason: "workspace_toml_unreadable",
        message: `${WORKSPACE_TOML_PATH} on the steering repo does not read as workspace/v1, so the import cannot add ${input.relinked} to it`,
      };
    case "read":
      if (
        read.value.organization !== input.organization ||
        read.value.workspace !== input.workspace
      ) {
        return {
          ok: false,
          reason: "workspace_mismatch",
          message: `${WORKSPACE_TOML_PATH} on the steering repo names ${read.value.organization}/${read.value.workspace}, not ${input.organization}/${input.workspace}`,
        };
      }
      if (read.repositories.includes(input.relinked)) {
        return { ok: true, content: null };
      }
      return { ok: true, content: withRepository(read, input.relinked) };
  }
}

/**
 * The old .oxagen/workspace.toml's keys the new file has no place for, or a
 * refusal when it names another workspace.
 */
function legacyWorkspaceDropped(
  input: OxagenTreeInput,
  source: string,
): { ok: true; dropped: string[] } | { ok: false; message: string } {
  let tree: unknown;
  try {
    tree = parseToml(source);
  } catch {
    return { ok: true, dropped: ["(the file is not TOML)"] };
  }
  if (!isRecord(tree)) return { ok: true, dropped: [] };
  const workspace = isRecord(tree.workspace) ? tree.workspace : {};
  const organization = text(workspace, "organization");
  const slug = text(workspace, "slug");
  if (
    (organization !== null && organization !== input.organization) ||
    (slug !== null && slug !== input.workspace)
  ) {
    return {
      ok: false,
      message: `${LEGACY_WORKSPACE_TOML_PATH} names ${organization ?? "?"}/${slug ?? "?"}, not ${input.organization}/${input.workspace}`,
    };
  }
  const kept = new Set(["workspace.organization", "workspace.slug", "repository.name"]);
  return { ok: true, dropped: leafKeys(tree).filter((key) => !kept.has(key)) };
}

// ── Agents ───────────────────────────────────────────────────────────────────

function agentToml(fields: Record<string, string>): string {
  return [
    schemaDirective("agent/v1"),
    ...Object.entries(fields).map(
      ([key, value]) => `${key} = ${JSON.stringify(value)}`,
    ),
    "",
  ].join("\n");
}

function convertAgents(
  agents: readonly ImportAgent[],
  legacyAgentPaths: readonly string[],
  set: string,
): { branches: ImportBranch[]; byHand: AgentByHand[] } {
  const branches: ImportBranch[] = [];
  const byHand: AgentByHand[] = [];
  const written = new Set<string>();
  for (const agent of [...agents].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    const name = `${set}.${agent.slug}`;
    const missing = (["operator", "runtime", "harness"] as const).filter(
      (field) => !agent[field],
    );
    if (missing.length > 0) {
      byHand.push({
        name,
        reason: `Oxagen holds no ${missing.join(", ")} for the agent`,
      });
      continue;
    }
    const fields = {
      schema: "agent/v1",
      name,
      label: agent.label.trim().slice(0, AGENT_LABEL_MAX).trimEnd() || agent.slug,
      operator: agent.operator as string,
      runtime: agent.runtime as string,
      harness: agent.harness as string,
    };
    const parsed = agentSchema.safeParse(fields);
    if (!parsed.success) {
      byHand.push({
        name,
        reason: `the agent does not read as agent/v1: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
      });
      continue;
    }
    const content = agentToml(fields);
    const read = readTomlFile(content, "agent/v1", agentSchema);
    if (!read.ok || !isDeepStrictEqual(read.value, parsed.data)) {
      byHand.push({ name, reason: "the agent file does not read back as agent/v1" });
      continue;
    }
    written.add(agent.slug);
    branches.push({
      branch: importAgentBranch(name),
      files: [{ path: agentFilePath(name), content }],
      records: [],
    });
  }
  for (const path of legacyAgentPaths) {
    const slug = path.slice(LEGACY_AGENTS_DIR.length + 1).replace(/\.toml$/, "");
    if (written.has(slug) || agents.some((agent) => agent.slug === slug)) continue;
    byHand.push({
      name: `${set}.${slug}`,
      reason: `${path} is from before ADR-198, and Oxagen holds no agent with that slug`,
    });
  }
  return { branches, byHand };
}

// ── Batches ──────────────────────────────────────────────────────────────────

/** Files that go in one import batch together: a record, a skill's folder, or governance.toml. */
interface ImportUnit {
  files: ImportFile[];
  records: ImportedRecord[];
}

/**
 * The import batches: the units in path order, as few batches as fit, with
 * each unit whole in one batch. Each batch leaves one file for
 * {@link IMPORT_REPLACES_PATH}, which it holds when it converts any record.
 */
function importBatches(
  units: readonly ImportUnit[],
): { ok: true; branches: ImportBranch[] } | { ok: false; reason: ImportRefusalReason; message: string } {
  const room = STEERING_PR_MAX_FILES - 1;
  const sorted = [...units].sort((a, b) => byPath(a.files[0] as ImportFile, b.files[0] as ImportFile));
  const batches: ImportUnit[] = [];
  let current: ImportUnit | null = null;
  for (const unit of sorted) {
    if (unit.files.length > room) {
      return {
        ok: false,
        reason: "too_many_files",
        message: `${(unit.files[0] as ImportFile).path} comes with ${unit.files.length} files, and one steering PR changes at most ${STEERING_PR_MAX_FILES}, including ${IMPORT_REPLACES_PATH}`,
      };
    }
    if (current === null || current.files.length + unit.files.length > room) {
      current = { files: [], records: [] };
      batches.push(current);
    }
    current.files.push(...unit.files);
    current.records.push(...unit.records);
  }
  return {
    ok: true,
    branches: batches.map((batch, index) => {
      const replaces = new Map<string, string>();
      for (const record of batch.records) {
        replaces.set(record.to, record.old_id);
      }
      const files = [...batch.files];
      if (replaces.size > 0) {
        files.push({ path: IMPORT_REPLACES_PATH, content: renderReplacesFile(replaces) });
      }
      return {
        branch: importBranch(index + 1),
        files: files.sort(byPath),
        records: [...batch.records].sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)),
      };
    }),
  };
}

// ── The conversion ───────────────────────────────────────────────────────────

/**
 * Convert a workspace's `.oxagen/` tree to the files of its import steering
 * PRs. A record that needs a person's choice is listed and left out, so a dry
 * run can show every choice at once.
 */
export function convertOxagenTree(input: OxagenTreeInput): OxagenTreeResult {
  const set = `${input.organization}.${input.workspace}`;
  const ctx: RecordContext = {
    set,
    relinked: input.relinked,
    ruleKinds: input.ruleKinds ?? {},
    constraintEffects: input.constraintEffects ?? {},
  };
  const paths = [...input.files.keys()]
    .filter((path) => path.startsWith(`${LEGACY_OXAGEN_DIR}/`))
    .sort();
  const units: ImportUnit[] = [];
  const records: ImportedRecord[] = [];
  const replaces = new Map<string, string>();
  const skills: { from: string; to: string; lineage: string }[] = [];
  const dropped: Record<string, string[]> = {};
  const cleanup = new Set<string>();
  const unconverted: Unconverted[] = [];
  const rulesNeedingKind: string[] = [];
  const constraintsNeedingEffect: string[] = [];
  const handled = new Set<string>();
  const lineages = new Set<string>();

  // Governance: the mode moves, and a missing file meant team.
  const legacyGovernance = input.files.get(LEGACY_GOVERNANCE_PATH) ?? null;
  const mode = parseGovernanceMode(legacyGovernance);
  if (typeof mode !== "string") {
    return {
      ok: false,
      reason: "governance_unreadable",
      message: `${LEGACY_GOVERNANCE_PATH}: ${mode.error}`,
    };
  }
  if (legacyGovernance !== null) {
    handled.add(LEGACY_GOVERNANCE_PATH);
    cleanup.add(LEGACY_GOVERNANCE_PATH);
    const tree = parseToml(legacyGovernance);
    addDropped(
      dropped,
      LEGACY_GOVERNANCE_PATH,
      leafKeys(tree).filter((key) => key !== "mode"),
    );
  }
  const governance = governanceFile(mode, input.governanceToml ?? null);
  if (!governance.ok) return governance;

  // workspace.toml: the old file's workspace must be this one.
  const legacyWorkspace = input.files.get(LEGACY_WORKSPACE_TOML_PATH);
  if (legacyWorkspace !== undefined) {
    const read = legacyWorkspaceDropped(input, legacyWorkspace);
    if (!read.ok) {
      return { ok: false, reason: "workspace_mismatch", message: read.message };
    }
    handled.add(LEGACY_WORKSPACE_TOML_PATH);
    cleanup.add(LEGACY_WORKSPACE_TOML_PATH);
    addDropped(dropped, LEGACY_WORKSPACE_TOML_PATH, read.dropped);
  }
  const workspace = workspaceFile(input);
  if (!workspace.ok) return workspace;

  // Records: every [[record]] of every file directly under .oxagen/rules/.
  for (const path of paths) {
    if (!path.startsWith(`${LEGACY_RULES_DIR}/`) || !path.endsWith(".toml")) continue;
    if (path === LEGACY_GOVERNANCE_PATH || path.slice(LEGACY_RULES_DIR.length + 1).includes("/")) continue;
    handled.add(path);
    const file = readLegacyRecordFile(input.files.get(path) as string);
    if (!file.ok) {
      unconverted.push({ path, reason: file.reason });
      continue;
    }
    addDropped(dropped, path, file.dropped);
    let whole = true;
    for (const [index, raw] of file.records.entries()) {
      const oldLineage = text(raw, "lineage_id");
      if (oldLineage === null) {
        unconverted.push({ path, reason: `record ${index + 1} has no lineage_id` });
        whole = false;
        continue;
      }
      const converted = convertRecord(path, oldLineage, raw, ctx);
      if (converted.kind === "needs_kind") {
        rulesNeedingKind.push(oldLineage);
        whole = false;
        continue;
      }
      if (converted.kind === "needs_effect") {
        constraintsNeedingEffect.push(oldLineage);
        whole = false;
        continue;
      }
      if (converted.kind === "unconverted") {
        unconverted.push({ path, lineage: oldLineage, reason: converted.reason });
        whole = false;
        continue;
      }
      if (lineages.has(converted.lineage)) {
        unconverted.push({
          path,
          lineage: oldLineage,
          reason: `another record already converts to ${converted.lineage}`,
        });
        whole = false;
        continue;
      }
      lineages.add(converted.lineage);
      const to = `${IMPORT_RECORDS_DIR}/${converted.lineage}.md`;
      addDropped(dropped, path, converted.dropped);
      const imported: ImportedRecord = {
        from: path,
        old_lineage: oldLineage,
        old_id: converted.oldId,
        to,
        lineage: converted.lineage,
        kind: converted.recordKind,
        id: converted.id,
      };
      records.push(imported);
      units.push({ files: [{ path: to, content: converted.text }], records: [imported] });
      replaces.set(to, converted.oldId);
    }
    if (whole) cleanup.add(path);
  }

  // Skills: one folder each under .oxagen/skills/, with SKILL.md and its assets.
  const skillFolders = new Map<string, string[]>();
  for (const path of paths) {
    if (!path.startsWith(`${LEGACY_SKILLS_DIR}/`)) continue;
    const rest = path.slice(LEGACY_SKILLS_DIR.length + 1);
    const slash = rest.indexOf("/");
    if (slash === -1) continue;
    const name = rest.slice(0, slash);
    skillFolders.set(name, [...(skillFolders.get(name) ?? []), path]);
  }
  for (const [name, files] of skillFolders) {
    const skillPath = `${LEGACY_SKILLS_DIR}/${name}/SKILL.md`;
    const lineage = `${set}.${name}`;
    let reason: string | null = null;
    if (!SKILL_NAME.test(name) || !lineageSchema.safeParse(lineage).success) {
      reason = `${name} is not a skill name: lowercase letters, digits, and hyphens`;
    } else if (!input.files.has(skillPath)) {
      reason = "the folder has no SKILL.md";
    } else if (lineages.has(lineage)) {
      reason = `another record already converts to ${lineage}`;
    }
    const converted = reason === null
      ? convertSkill(skillPath, name, input.files.get(skillPath) as string, set, input.relinked)
      : null;
    if (converted && !converted.ok) reason = converted.reason;
    if (reason !== null || !converted || !converted.ok) {
      for (const path of files) {
        handled.add(path);
        unconverted.push({ path, reason: reason ?? "the skill does not convert" });
      }
      continue;
    }
    lineages.add(lineage);
    const to = skillFilePath(lineage);
    const unit: ImportUnit = { files: [{ path: to, content: converted.text }], records: [] };
    units.push(unit);
    addDropped(dropped, skillPath, converted.dropped);
    skills.push({ from: skillPath, to, lineage });
    handled.add(skillPath);
    cleanup.add(skillPath);
    for (const path of files) {
      if (path === skillPath) continue;
      handled.add(path);
      const content = input.files.get(path) as string;
      if (looksBinary(content)) {
        unconverted.push({
          path,
          reason: "the file is not UTF-8 text, so the import cannot copy it",
        });
        continue;
      }
      const asset = `${skillFolderPath(lineage)}/${path.slice(`${LEGACY_SKILLS_DIR}/${name}/`.length)}`;
      unit.files.push({ path: asset, content });
      cleanup.add(path);
    }
  }

  // Agents: files from before ADR-198 are removed, and the stored agents are written.
  const legacyAgentPaths = paths.filter(
    (path) => path.startsWith(`${LEGACY_AGENTS_DIR}/`) && path.endsWith(".toml") && !path.slice(LEGACY_AGENTS_DIR.length + 1).includes("/"),
  );
  for (const path of legacyAgentPaths) {
    handled.add(path);
    cleanup.add(path);
  }
  const agents = convertAgents(input.agents ?? [], legacyAgentPaths, set);

  // Machine-local files stay, and the keep files go once their folder is empty.
  for (const path of paths) {
    if (MACHINE_LOCAL_FILES.has(path)) handled.add(path);
  }
  for (const keep of LEGACY_KEEP_FILES) {
    if (!input.files.has(keep)) continue;
    handled.add(keep);
    const folder = keep.slice(0, keep.lastIndexOf("/") + 1);
    const others = paths.some(
      (path) => path !== keep && path.startsWith(folder) && !cleanup.has(path),
    );
    if (!others) cleanup.add(keep);
  }
  for (const path of paths) {
    if (handled.has(path)) continue;
    unconverted.push({
      path,
      reason: "the steering repo has no place for this file",
    });
  }

  // The steering PRs.
  if (governance.content !== null) {
    units.push({
      files: [{ path: GOVERNANCE_TOML_PATH, content: governance.content }],
      records: [],
    });
  }
  const batches = importBatches(units);
  if (!batches.ok) return batches;
  const branches: ImportBranch[] = [...batches.branches];
  if (workspace.content !== null) {
    branches.push({
      branch: IMPORT_WORKSPACE_BRANCH,
      files: [{ path: WORKSPACE_TOML_PATH, content: workspace.content }],
      records: [],
    });
  }
  branches.push(...agents.branches);
  for (const branch of branches) {
    if (branch.files.length > STEERING_PR_MAX_FILES) {
      return {
        ok: false,
        reason: "too_many_files",
        message: `${branch.branch} would change ${branch.files.length} files, and one steering PR changes at most ${STEERING_PR_MAX_FILES}`,
      };
    }
    const scope = branchScopeRefusal(
      branch.branch,
      branch.files.map((file) => file.path),
    );
    if (scope) {
      return { ok: false, reason: "branch_scope", message: scope.message };
    }
  }

  return {
    ok: true,
    conversion: {
      set,
      branches,
      records,
      replaces,
      skills,
      governanceMode: mode,
      dropped,
      cleanupPaths: [...cleanup].sort(),
      unconverted: unconverted.sort(byPath),
      rulesNeedingKind: rulesNeedingKind.sort(),
      constraintsNeedingEffect: constraintsNeedingEffect.sort(),
      agentsByHand: agents.byHand,
    },
  };
}

// ── Pull request bodies ──────────────────────────────────────────────────────

/** The id table an import PR's body carries: each record's path and its id before and after. */
export function renderIdTable(records: readonly ImportedRecord[]): string {
  const rows = [...records]
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
    .map(
      (record) =>
        `| \`${record.to}\` | \`${record.old_id ?? "none"}\` | \`${record.id}\` |`,
    );
  return ["| Record | Old id | New id |", "|---|---|---|", ...rows].join("\n");
}

/**
 * One line for each file the conversion dropped fields from, sorted by path:
 * the file, then each field. `only` limits the lines to the files it keeps.
 * A reason in parentheses, such as "(the file is not TOML)", reads as text.
 */
export function droppedFieldLines(
  dropped: Readonly<Record<string, readonly string[]>>,
  only: (path: string) => boolean = () => true,
): string[] {
  return Object.keys(dropped)
    .filter((path) => only(path) && (dropped[path]?.length ?? 0) > 0)
    .sort()
    .map((path) => {
      const fields = (dropped[path] ?? []).map((key) =>
        key.startsWith("(") && key.endsWith(")") ? key.slice(1, -1) : `\`${key}\``,
      );
      return `- \`${path}\`: ${fields.join(", ")}`;
    });
}

/**
 * The body of one import steering PR. An import batch lists the records and
 * skills it converts, with each record's id before and after. The first
 * batch also names the governance mode. The first PR the import opens lists
 * the files and agents it leaves for a person, and the fields it drops.
 */
export function importPullRequestBody(
  conversion: OxagenTreeConversion,
  branch: ImportBranch,
  relinked: string,
): string {
  const batches = conversion.branches.filter((b) => isImportBranch(b.branch)).length;
  const lines = [
    `This steering PR imports the workspace's steering from \`.oxagen/\` in ${relinked}. The import opens these steering PRs:`,
    "",
    `- ${batches === 1 ? "one import batch" : `${batches} import batches`} of at most ${STEERING_PR_MAX_FILES} files each, on \`${IMPORT_BRANCH}\`${batches > 1 ? ` through \`${importBranch(batches)}\`` : ""}, for records, skills, and \`${GOVERNANCE_TOML_PATH}\`;`,
    `- \`${IMPORT_WORKSPACE_BRANCH}\` for \`${WORKSPACE_TOML_PATH}\`;`,
    "- one `agents/` PR for each agent Oxagen can write.",
    "",
    "Merge each of them from Oxagen, on the workspace's Steering page, in the order above. Oxagen lands each one through its merge queue with the stamp and the ledger line. A merge on GitHub leaves the steering repo diverged.",
  ];
  if (isImportBranch(branch.branch)) {
    if (branch.records.length > 0) {
      lines.push(
        "",
        "## Records",
        "",
        `Each record's id changes once, when this PR merges. This PR adds \`${IMPORT_REPLACES_PATH}\`, which names each old id. The stamp writes each old id as \`replaces\` on this PR's ledger line and deletes the file.`,
        "",
        renderIdTable(branch.records),
      );
    }
    const paths = new Set(branch.files.map((file) => file.path));
    const skills = conversion.skills.filter((skill) => paths.has(skill.to));
    if (skills.length > 0) {
      lines.push(
        "",
        "## Skills",
        "",
        ...skills.map((skill) => `- \`${skill.from}\` becomes \`${skill.to}\``),
      );
    }
    if (branch.branch === IMPORT_BRANCH) {
      lines.push(
        "",
        "## Governance",
        "",
        `The mode is \`${conversion.governanceMode}\`.`,
      );
    }
  }
  // The first PR the import opens names what it leaves for a person, so a
  // reviewer reads it once, whichever PRs the import needed.
  if (conversion.branches[0]?.branch === branch.branch) {
    const waiting = [
      ...conversion.unconverted.map(
        (item) =>
          `- \`${item.path}\`${item.lineage ? ` (\`${item.lineage}\`)` : ""}: ${item.reason}`,
      ),
      ...conversion.rulesNeedingKind.map(
        (lineage) => `- \`${lineage}\`: a person names the rule a business rule or a code rule`,
      ),
      ...conversion.constraintsNeedingEffect.map(
        (lineage) => `- \`${lineage}\`: a person gives the constraint its effect`,
      ),
    ];
    if (waiting.length > 0) {
      lines.push(
        "",
        "## Files to place by hand",
        "",
        `These stay in \`.oxagen/\` in ${relinked}, and the cleanup PR keeps them.`,
        "",
        ...waiting,
      );
    }
    if (conversion.agentsByHand.length > 0) {
      lines.push(
        "",
        "## Agents to place by hand",
        "",
        "Oxagen writes an agent only when it holds the agent's operator, runtime, and harness.",
        "",
        ...conversion.agentsByHand.map((agent) => `- \`${agent.name}\`: ${agent.reason}`),
      );
    }
    const dropped = droppedFieldLines(conversion.dropped);
    if (dropped.length > 0) {
      lines.push(
        "",
        "## Dropped fields",
        "",
        `The steering repo has no place for these fields, so the import leaves them out. The cleanup PR deletes the files that hold them from ${relinked}. Move any field you still need by hand before you merge it.`,
        "",
        ...dropped,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
