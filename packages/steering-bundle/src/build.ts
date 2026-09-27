// build.ts: one published version, `bundle/v1`, built from a merged tree
// (steering-repo-spec, Steering PR flow: Publish; Shared contract: Bundle).
//
// The build is incremental by blob id. A record whose file has the same blob
// as in the previous version keeps its entry, and a file whose blob the cache
// holds is not fetched again. Only new or changed files cost a read.
import type { AgentFile } from "@oxagen/oxagen/steering-repo/agent";
import { agentSchema } from "@oxagen/oxagen/steering-repo/agent";
import {
  bundleSchema,
  type Bundle,
  type BundleRecord,
} from "@oxagen/oxagen/steering-repo/bundle";
import { readJsonLines, readTomlFile, type FileIssue } from "@oxagen/oxagen/steering-repo/files";
import { toolTargetMatches } from "@oxagen/oxagen/steering-repo/names";
import {
  CEDAR_SCHEMA_PATH,
  classifySteeringRepoPath,
  POLICY_DIR,
  WORKSPACE_TOML_PATH,
} from "@oxagen/oxagen/steering-repo/paths";
import { promotionSchema } from "@oxagen/oxagen/steering-repo/promotion";
import {
  effectiveLoad,
  readSteeringRecord,
  stampRecord,
} from "@oxagen/oxagen/steering-repo/record";
import { countTokens } from "@oxagen/oxagen/steering-repo/tokens";
import { workspaceSchema } from "@oxagen/oxagen/steering-repo/workspace";
import { toolModesOf } from "./mentions";
import {
  blockHeading,
  indexTokens,
  recordSection,
  recordTokens,
  renderBlock,
} from "./render";
import { buildTools, compileServerFolder, type ToolCompiler } from "./tools";
import { compareText, type TreeReader } from "./tree";

/** A file that stops the version from building. The steering PR's checks should have caught it. */
export class BundleBuildError extends Error {
  constructor(
    readonly path: string,
    readonly issues: readonly FileIssue[],
  ) {
    super(
      `${path} does not read, so the version was not built: ${issues
        .map((issue) => (issue.line === null ? issue.message : `line ${issue.line}: ${issue.message}`))
        .join("; ")}`,
    );
    this.name = "BundleBuildError";
  }
}

/** Which repository the version is for. */
export interface BundleIdentity {
  /** The steering repo, or the organization repo: `github.com/a-intel/oxagen-core-platform`. */
  repository: string;
  scope: Bundle["scope"];
  organization: string;
  /** The workspace slug. Required for a workspace's version, absent for the organization's. */
  workspace?: string;
}

export interface BuildInput {
  identity: BundleIdentity;
  version: number;
  commit: string;
  published_at: string;
  reader: TreeReader;
  /** The version before this one, whose unchanged records are reused. */
  previous: Bundle | null;
  /** Compiles a server folder. MCP Studio's compile() when unset. */
  compiler?: ToolCompiler;
}

export interface BuildResult {
  bundle: Bundle;
  warnings: string[];
}

type Entry = BundleRecord;

function isAlwaysOnEntry(entry: Entry): boolean {
  return (entry.force === "must" || entry.force === "should") && entry.load === "always";
}

async function readRecord(
  reader: TreeReader,
  path: string,
  previous: ReadonlyMap<string, Entry>,
  bodies: Map<string, string>,
): Promise<Entry | null> {
  const blob = await reader.blob(path);
  const kept = previous.get(path);
  if (kept !== undefined && kept.blob === blob) return { ...kept, files: undefined };

  const text = await reader.read(path);
  const read = readSteeringRecord(text);
  if (!read.ok) throw new BundleBuildError(path, read.issues);
  const { record, body } = read;
  if (record.status === "archived") return null;
  bodies.set(path, body);
  const stamp =
    record.id !== undefined && record.hash !== undefined
      ? { id: record.id, hash: record.hash }
      : stampRecord(record as unknown as Record<string, unknown>, body);
  // Fields in bundle/v1's order, so the stored JSON reads the same each time.
  return {
    lineage: record.lineage,
    path,
    blob,
    id: stamp.id,
    hash: stamp.hash,
    label: record.label,
    ...(record.description === undefined ? {} : { description: record.description }),
    kind: record.kind,
    ...(record.name === undefined ? {} : { name: record.name }),
    ...(record.effect === undefined ? {} : { effect: record.effect }),
    force: record.force,
    scope: record.scope,
    load: effectiveLoad(record),
    ...(record.repos === undefined ? {} : { repos: record.repos }),
    ...(record.tools === undefined ? {} : { tools: record.tools }),
    ...(record.skills === undefined ? {} : { skills: record.skills }),
    ...(record.applies_to === undefined ? {} : { applies_to: record.applies_to }),
    tokens: recordTokens(record.label, body),
    index_tokens: indexTokens(record),
  };
}

/** A skill's other files: every file in its folder but SKILL.md, in path order. */
async function skillFiles(
  reader: TreeReader,
  skillPath: string,
): Promise<NonNullable<Entry["files"]>> {
  const folder = skillPath.slice(0, skillPath.lastIndexOf("/") + 1);
  const files: NonNullable<Entry["files"]> = [];
  for (const path of reader.paths) {
    if (path.startsWith(folder) && classifySteeringRepoPath(path) === "skill-asset") {
      files.push({ path, blob: await reader.blob(path) });
    }
  }
  return files;
}

/** The body of a record, read once. */
async function bodyOf(
  reader: TreeReader,
  entry: Entry,
  bodies: Map<string, string>,
): Promise<string> {
  const held = bodies.get(entry.path);
  if (held !== undefined) return held;
  const read = readSteeringRecord(await reader.read(entry.path));
  if (!read.ok) throw new BundleBuildError(entry.path, read.issues);
  bodies.set(entry.path, read.body);
  return read.body;
}

/** The code repositories a version renders a block for, then null for any other. */
function blockRepositories(
  scope: Bundle["scope"],
  linked: readonly string[],
  records: readonly Entry[],
): Array<string | null> {
  if (scope === "workspace") return [...linked, null];
  const named = new Set<string>();
  for (const entry of records) {
    if (isAlwaysOnEntry(entry)) for (const repo of entry.repos ?? []) named.add(repo);
  }
  return [...[...named].sort(compareText), null];
}

/** Does an always-on record reach every request of a run on this repository? */
function inBlock(entry: Entry, repository: string | null, imported: readonly string[]): boolean {
  if (!isAlwaysOnEntry(entry)) return false;
  // A record for one skill reaches only a request that runs that skill.
  if (entry.skills !== undefined) return false;
  if (entry.repos !== undefined && (repository === null || !entry.repos.includes(repository))) {
    return false;
  }
  if (entry.tools !== undefined) {
    const targets = entry.tools;
    return imported.some((name) => targets.some((target) => toolTargetMatches(target, name)));
  }
  return true;
}

async function buildPolicies(reader: TreeReader, warnings: string[]): Promise<Bundle["policies"]> {
  if (!reader.paths.some((path) => path.startsWith(`${POLICY_DIR}/`))) return null;
  let schema = "";
  if (reader.has(CEDAR_SCHEMA_PATH)) {
    schema = await reader.read(CEDAR_SCHEMA_PATH);
  } else {
    warnings.push(`${CEDAR_SCHEMA_PATH} is missing, so the policy set has no schema.`);
  }
  const policies: NonNullable<Bundle["policies"]>["policies"] = [];
  for (const path of reader.paths) {
    if (classifySteeringRepoPath(path) !== "policy") continue;
    policies.push({ path, blob: await reader.blob(path), text: await reader.read(path) });
  }
  return { schema, policies };
}

async function buildAgents(reader: TreeReader): Promise<AgentFile[]> {
  const agents: AgentFile[] = [];
  for (const path of reader.paths) {
    if (classifySteeringRepoPath(path) !== "agent") continue;
    const read = readTomlFile(await reader.read(path), "agent/v1", agentSchema);
    if (!read.ok) throw new BundleBuildError(path, read.issues);
    agents.push(read.value);
  }
  return agents;
}

async function buildLedger(reader: TreeReader): Promise<Bundle["ledger"]> {
  let last: Bundle["ledger"] = null;
  for (const path of reader.paths) {
    if (classifySteeringRepoPath(path) !== "ledger") continue;
    const read = readJsonLines(await reader.read(path), promotionSchema);
    if (!read.ok) throw new BundleBuildError(path, read.issues);
    for (const line of read.value) {
      if (last === null || line.seq > last.seq) last = { path, seq: line.seq, hash: line.hash };
    }
  }
  return last;
}

async function linkedRepositories(reader: TreeReader, scope: Bundle["scope"]): Promise<string[]> {
  if (scope !== "workspace") return [];
  if (!reader.has(WORKSPACE_TOML_PATH)) {
    throw new BundleBuildError(WORKSPACE_TOML_PATH, [
      { line: null, field: null, message: "a workspace's steering repo needs workspace.toml" },
    ]);
  }
  const read = readTomlFile(await reader.read(WORKSPACE_TOML_PATH), "workspace/v1", workspaceSchema);
  if (!read.ok) throw new BundleBuildError(WORKSPACE_TOML_PATH, read.issues);
  return (read.value.repositories ?? []).map((repository) => repository.url);
}

/** Build one version from a merged tree. Throws BundleBuildError when a file does not read. */
export async function buildBundle(input: BuildInput): Promise<BuildResult> {
  const { reader, identity } = input;
  const warnings: string[] = [];
  const previous = new Map<string, Entry>(
    (input.previous?.records ?? []).map((entry) => [entry.path, entry]),
  );
  const bodies = new Map<string, string>();

  const linked = await linkedRepositories(reader, identity.scope);
  const tools = await buildTools(reader, input.compiler ?? compileServerFolder);
  warnings.push(...tools.warnings);

  const records: Entry[] = [];
  for (const path of reader.paths) {
    const kind = classifySteeringRepoPath(path);
    if (kind !== "record" && kind !== "skill-record") continue;
    const entry = await readRecord(reader, path, previous, bodies);
    if (entry === null) continue;
    if (kind === "skill-record") entry.files = await skillFiles(reader, path);
    else delete entry.files;
    records.push(entry);
  }
  records.sort((a, b) => compareText(a.lineage, b.lineage));

  const manifest: Bundle["tools"] =
    tools.servers.length === 0
      ? null
      : { schema: "tool-manifest/v1", servers: tools.servers };
  // The modes the manifest records. steering_read and each request read the
  // same ones, so a record's mentions render the same wherever it appears.
  const modes = toolModesOf({ tools: manifest });
  const always_on: Bundle["always_on"] = [];
  for (const repository of blockRepositories(identity.scope, linked, records)) {
    const members = records.filter((entry) => inBlock(entry, repository, tools.imported));
    const sections: string[] = [];
    for (const entry of members) {
      sections.push(recordSection(entry.label, await bodyOf(reader, entry, bodies), modes));
    }
    const text = renderBlock(blockHeading(identity.scope), sections);
    always_on.push({
      repository,
      text,
      tokens: countTokens(text),
      lineages: members.map((entry) => entry.lineage),
    });
  }

  const bundle = {
    schema: "bundle/v1" as const,
    repository: identity.repository,
    scope: identity.scope,
    organization: identity.organization,
    ...(identity.workspace === undefined ? {} : { workspace: identity.workspace }),
    version: input.version,
    commit: input.commit,
    ledger: await buildLedger(reader),
    published_at: input.published_at,
    records,
    always_on,
    policies: await buildPolicies(reader, warnings),
    agents: await buildAgents(reader),
    tools: manifest,
  };
  const checked = bundleSchema.safeParse(bundle);
  if (!checked.success) {
    throw new BundleBuildError(
      "bundle/v1",
      checked.error.issues.map((issue) => ({
        line: null,
        field: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return { bundle: checked.data, warnings };
}
