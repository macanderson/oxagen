// references.ts: every name a file gives must name something that exists. A
// record's repos, skills, tools, and @mentions resolve against the tree. An
// agent's runtime and operator, a reviewer group, and a credential resolve
// against what Oxagen knows outside the repository.
import {
  classifySteeringRepoPath,
  findMentions,
  GOVERNANCE_TOML_PATH,
  parseCredentialRef,
  parseToolRef,
  SKILL_FILE_NAME,
  toolTargetMatches,
} from "@oxagen/oxagen/steering-repo";
import { finder, type TreeCheck } from "../finding";
import {
  bodyOffsetLine,
  isRecord,
  isString,
  parseTomlLoose,
  recordFieldLine,
  recordFiles,
  serverFolders,
  tomlLine,
  workspaceRepositories,
  type RecordFile,
} from "../repo";
import type { CheckContext, Finding, SteeringTree } from "../types";

const find = finder("references");

/** The tool names a tree imports: `<server>__<key>` for every key in each server's tools.toml. */
export function importedTools(tree: SteeringTree): { servers: Set<string>; tools: string[] } {
  const servers = new Set<string>();
  const tools: string[] = [];
  for (const [name, folder] of serverFolders(tree)) {
    servers.add(name);
    const keys = folder.tools.size > 0 ? folder.tools : folder.locked;
    for (const key of keys.keys()) tools.push(`${name}__${key}`);
  }
  return { servers, tools: tools.sort() };
}

/** Edit distance between two strings, for the closest-name hint. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(
        Math.min((previous[j] as number) + 1, (current[j - 1] as number) + 1, (previous[j - 1] as number) + cost),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** The known name closest to `name`, when one is close enough to be a typo. */
export function closest(name: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Math.max(2, Math.floor(name.length / 4)) + 1;
  for (const candidate of known) {
    const d = distance(name, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

function didYouMean(name: string, known: readonly string[]): string {
  const hint = closest(name, known);
  return hint === null ? "" : ` Did you mean ${hint}?`;
}

interface Universe {
  repositories: string[] | null;
  skills: Set<string>;
  records: Set<string>;
  servers: Set<string>;
  tools: string[];
}

function universe(tree: SteeringTree, files: readonly RecordFile[]): Universe {
  const skills = new Set<string>();
  const records = new Set<string>();
  for (const file of files) {
    if (file.lineage === null || file.raw.status !== "active") continue;
    records.add(file.lineage);
    if (file.raw.kind === "skill") skills.add(file.lineage);
  }
  const { servers, tools } = importedTools(tree);
  return { repositories: workspaceRepositories(tree), skills, records, servers, tools };
}

/** Does a tool target name a tool the tree imports? A `<server>__*` target needs the server. */
function toolResolves(target: string, known: Universe): boolean {
  if (target.endsWith("__*")) return known.servers.has(target.slice(0, -3));
  const ref = parseToolRef(target);
  const name = ref === null ? target : `${ref.server}__${ref.tool}`;
  return known.tools.some((tool) => toolTargetMatches(name, tool));
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter(isString) : [];
}

function recordFieldFindings(file: RecordFile, text: string, known: Universe): Finding[] {
  const findings: Finding[] = [];
  const at = (field: string) => recordFieldLine(file, text, field);
  const linked = known.repositories;
  if (linked !== null) {
    stringItems(file.raw.repos).forEach((repo, n) => {
      if (linked.includes(repo)) return;
      findings.push(
        find({
          rule: "repository-linked",
          path: file.path,
          line: at(`repos.${n}`),
          field: `repos.${n}`,
          message: `The record names ${repo}, and workspace.toml does not link it.`,
          expected: linked.length === 0 ? "A repository workspace.toml links." : `A repository workspace.toml links: ${linked.join(", ")}.`,
          fix: `Link ${repo} to the workspace in Oxagen, or correct the name.`,
        }),
      );
    });
  }
  const skillList = [...known.skills].sort();
  stringItems(file.raw.skills).forEach((skill, n) => {
    if (known.skills.has(skill)) return;
    findings.push(
      find({
        rule: "skill-exists",
        path: file.path,
        line: at(`skills.${n}`),
        field: `skills.${n}`,
        message: `The record names the skill ${skill}, and no active skill has that lineage.${didYouMean(skill, skillList)}`,
        expected: "The lineage of an active skill under steering/skills/.",
        fix: `Correct the lineage, or add the skill at steering/skills/${skill}/SKILL.md.`,
      }),
    );
  });
  stringItems(file.raw.tools).forEach((target, n) => {
    if (toolResolves(target, known)) return;
    findings.push(toolFinding(file.path, at(`tools.${n}`), `tools.${n}`, target, known));
  });
  return findings;
}

function toolFinding(path: string, line: number | null, field: string, target: string, known: Universe): Finding {
  const server = target.split("__")[0] ?? target;
  const hasServer = known.servers.has(server);
  return find({
    rule: "tool-exists",
    path,
    line,
    field,
    message: `${target} names a tool no server in the workspace imports.${didYouMean(target, known.tools)}`,
    expected: "A tool name from a server's tools.toml, as <server>__<tool>, or <server>__* for all of them.",
    fix: hasServer
      ? `Correct the name, or import the tool in tools/servers/${server}/tools.toml.`
      : `Correct the name, or add the server ${server} under tools/servers/.`,
  });
}

const MENTION_TEXT = {
  record: "the lineage of an active record",
  skill: "the lineage of an active skill",
  tool: "a tool the workspace imports",
} as const;

const MENTION_MISS = {
  record: "no active record has that lineage",
  skill: "no active skill has that lineage",
  tool: "no server in the workspace imports that tool",
} as const;

function mentionFindings(file: RecordFile, known: Universe): Finding[] {
  const findings: Finding[] = [];
  for (const mention of findMentions(file.body)) {
    const resolves =
      mention.kind === "record"
        ? known.records.has(mention.target)
        : mention.kind === "skill"
          ? known.skills.has(mention.target)
          : toolResolves(mention.target, known);
    if (resolves) continue;
    const names =
      mention.kind === "record"
        ? [...known.records].sort()
        : mention.kind === "skill"
          ? [...known.skills].sort()
          : known.tools;
    findings.push(
      find({
        rule: "mention-resolves",
        path: file.path,
        line: bodyOffsetLine(file, mention.index),
        field: null,
        message: `The body mentions @${mention.kind}:${mention.target}, and ${MENTION_MISS[mention.kind]}.${didYouMean(mention.target, names)}`,
        expected: `@${mention.kind}: followed by ${MENTION_TEXT[mention.kind]}.`,
        fix: "Correct the mention, or remove it.",
      }),
    );
  }
  return findings;
}

// A file a SKILL.md names with @, such as @template.sql or @assets/logo.svg.
const FILE_MENTION = /(^|[\s(`'"])@([A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]+)/g;

function skillFileFindings(file: RecordFile, tree: SteeringTree): Finding[] {
  if (file.kind !== "skill-record") return [];
  const folder = file.path.slice(0, -`/${SKILL_FILE_NAME}`.length);
  const findings: Finding[] = [];
  for (const match of file.body.matchAll(FILE_MENTION)) {
    const name = (match[2] as string).replace(/[.]+$/, "");
    const target = `${folder}/${name}`;
    if (tree.has(target)) continue;
    findings.push(
      find({
        rule: "skill-file-exists",
        path: file.path,
        line: bodyOffsetLine(file, match.index + (match[1] as string).length),
        field: null,
        message: `The skill names @${name}, and ${target} does not exist.`,
        expected: "Each @file a SKILL.md names is in the skill's folder.",
        fix: `Add ${name} to the skill's folder, or remove the mention.`,
      }),
    );
  }
  return findings;
}

/** Every `oxagen:credential/` value in a parsed TOML file, with its dot-joined field. */
function credentialFields(value: unknown, prefix = ""): { field: string; name: string }[] {
  if (isString(value)) {
    const name = parseCredentialRef(value);
    return name === null ? [] : [{ field: prefix, name }];
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).flatMap((item, n) =>
      credentialFields(item, prefix === "" ? String(n) : `${prefix}.${n}`),
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    credentialFields(item, prefix === "" ? key : `${prefix}.${key}`),
  );
}

function credentialFindings(tree: SteeringTree, context: CheckContext): Finding[] {
  const findings: Finding[] = [];
  for (const [path, text] of tree) {
    const kind = classifySteeringRepoPath(path);
    if (kind !== "server" && kind !== "workspace") continue;
    const parsed = parseTomlLoose(text);
    for (const { field, name } of credentialFields(parsed)) {
      if (context.credentials.includes(name)) continue;
      findings.push(
        find({
          rule: "credential-exists",
          path,
          line: tomlLine(text, field),
          field,
          message: `The vault holds no credential named ${name}.${didYouMean(name, context.credentials)}`,
          expected: "oxagen:credential/<name> for a credential the workspace's vault holds.",
          fix: `Add ${name} to the vault in Oxagen, or correct the name.`,
        }),
      );
    }
  }
  return findings;
}

function groupFindings(tree: SteeringTree, context: CheckContext): Finding[] {
  const text = tree.get(GOVERNANCE_TOML_PATH);
  const parsed = parseTomlLoose(text);
  if (text === undefined || parsed === null || !Array.isArray(parsed.reviewers)) return [];
  const reviewers = parsed.reviewers as unknown[];
  const findings: Finding[] = [];
  reviewers.forEach((entry, n) => {
    if (!isRecord(entry) || !isString(entry.group) || context.groups.includes(entry.group)) return;
    const field = `reviewers.${n}.group`;
    findings.push(
      find({
        rule: "group-exists",
        path: GOVERNANCE_TOML_PATH,
        line: tomlLine(text, field),
        field,
        message: `No reviewer group named ${entry.group} exists in Oxagen.${didYouMean(entry.group, context.groups)}`,
        expected: "A reviewer group the organization has.",
        fix: `Create the group ${entry.group} in Oxagen, or name an existing group.`,
      }),
    );
  });
  return findings;
}

function agentFindings(tree: SteeringTree, context: CheckContext): Finding[] {
  const findings: Finding[] = [];
  const actors = [...context.members, ...context.teams];
  for (const [path, text] of tree) {
    if (classifySteeringRepoPath(path) !== "agent") continue;
    const parsed = parseTomlLoose(text);
    if (parsed === null) continue;
    const { runtime, operator } = parsed;
    if (isString(runtime) && !context.runtimes.includes(runtime)) {
      findings.push(
        find({
          rule: "runtime-enrolled",
          path,
          line: tomlLine(text, "runtime"),
          field: "runtime",
          message: `No runtime named ${runtime} is enrolled in Oxagen.${didYouMean(runtime, context.runtimes)}`,
          expected: "A runtime enrolled in Oxagen.",
          fix: `Enroll ${runtime} with tacho enroll, or name an enrolled runtime.`,
        }),
      );
    }
    if (isString(operator) && !actors.includes(operator)) {
      findings.push(
        find({
          rule: "operator-exists",
          path,
          line: tomlLine(text, "operator"),
          field: "operator",
          message: `No member or team named ${operator} exists in Oxagen.${didYouMean(operator, actors)}`,
          expected: "A member's handle or a team's slug in the organization.",
          fix: "Name a member or a team who answers for the agent.",
        }),
      );
    }
  }
  return findings;
}

function toolbeltFindings(tree: SteeringTree, known: Universe): Finding[] {
  const findings: Finding[] = [];
  for (const [path, text] of tree) {
    if (classifySteeringRepoPath(path) !== "toolbelt") continue;
    const parsed = parseTomlLoose(text);
    stringItems(parsed?.tools).forEach((target, n) => {
      if (toolResolves(target, known)) return;
      findings.push(toolFinding(path, tomlLine(text, `tools.${n}`), `tools.${n}`, target, known));
    });
  }
  return findings;
}

export const referencesCheck: TreeCheck = (tree, env) => {
  const files = recordFiles(tree);
  const known = universe(tree, files);
  const findings: Finding[] = [];
  for (const file of files) {
    const text = tree.get(file.path) as string;
    findings.push(...recordFieldFindings(file, text, known));
    findings.push(...mentionFindings(file, known));
    findings.push(...skillFileFindings(file, tree));
  }
  findings.push(...credentialFindings(tree, env.context));
  findings.push(...groupFindings(tree, env.context));
  findings.push(...agentFindings(tree, env.context));
  findings.push(...toolbeltFindings(tree, known));
  return findings;
};
