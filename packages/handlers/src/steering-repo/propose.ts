// steering-repo/propose.ts: what propose_steering checks and writes before it
// opens a steering PR (steering-repo-spec, Agent use, Managed blocks, and
// Steering PR flow). Everything here is pure except the managed block rule,
// which reads the production files through the opener.
//
// - Files only Oxagen writes are refused: the Cedar schema, a server's lock,
//   and anything under the ledger's folder.
// - Each record gets the provenance Oxagen writes: `source: proposal`, the run
//   as `uri`, and the proposing agent. A record that types `id` or `hash`,
//   names its own `provenance.agent`, or claims `provenance.source: run` is
//   refused instead.
// - The branch starts with the one folder every file belongs under.
// - The opener refuses a change to the managed block in AGENTS.md, CLAUDE.md,
//   or README.md, by the rule the steering checks' `owned` check uses.
import { HandlerError, type HandlerErrorCode } from "@oxagen/oxagen";
import {
  AGENTS_MD_PATH,
  CLAUDE_MD_PATH,
  classifySteeringRepoPath,
  PROMOTIONS_DIR,
  README_PATH,
  SKILLS_DIR,
  TOOL_SERVERS_DIR,
  type SteeringRepoFileKind,
} from "@oxagen/oxagen/steering-repo/paths";
import {
  parseFrontmatter,
  splitRecordFile,
} from "@oxagen/oxagen/steering-repo/record";
import { readManagedBlock } from "@oxagen/oxagen/steering-repo/templates";
import { stringify } from "yaml";
import {
  createSteeringPullRequestOpener,
  steeringFilesRefusal,
  workspaceSteeringPullRequestDeps,
  type SteeringPullRequestKind,
  type ToolsPullRequestFile,
  type ToolsPullRequestOpener,
} from "../tools.pr.open";
import { branchPrefixForPath } from "./stamp";

type Refusal = { reason: string; message: string };

function refuse(code: HandlerErrorCode, reason: string, message: string): HandlerError {
  return new HandlerError({ code, reason, message });
}

// ── Files only Oxagen writes ─────────────────────────────────────────────────

/** What each file only Oxagen writes holds, as the owned check words it. */
const OXAGEN_WRITES: Partial<Record<SteeringRepoFileKind, string>> = {
  "cedar-schema": "the Cedar schema, which Oxagen writes on publish from the imported tools and agents/",
  "server-lock": "a server's reviewed upstream definitions, which Oxagen writes when it syncs the server",
};

/**
 * The refusal for the first path only Oxagen writes, or null. Any path under
 * steering/promotions/ counts, whether or not its name is a ledger file's.
 */
export function ownedPathRefusal(paths: readonly string[]): HandlerError | null {
  for (const path of paths) {
    const what = path.startsWith(`${PROMOTIONS_DIR}/`)
      ? "the promotion ledger, which Oxagen writes when it stamps a merged steering PR"
      : OXAGEN_WRITES[classifySteeringRepoPath(path)];
    if (what === undefined) continue;
    return refuse(
      "conflict",
      "oxagen_owned_path",
      `${path} holds ${what}. Only Oxagen writes it. Leave it out, and change the files Oxagen builds it from instead.`,
    );
  }
  return null;
}

// ── Provenance ───────────────────────────────────────────────────────────────

/** The provenance Oxagen writes into a proposed record. */
export interface ProposalProvenance {
  /** `oxagen:run/<run>`, the run the agent proposed from. */
  uri: string;
  /** The agent's name, the lineage its agents/<name>.toml file gives it. */
  agent: string;
}

/** The provenance `uri` of a record an agent proposed from a run. */
export function proposalUri(run: string): string {
  return `oxagen:run/${run}`;
}

/** True for a path that holds a steering record or a skill's SKILL.md. */
export function isRecordPath(path: string): boolean {
  const kind = classifySteeringRepoPath(path);
  return kind === "record" || kind === "skill-record";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A record file with its `provenance` replaced by the one Oxagen writes. The
 * new block takes the old one's place, or follows `origin` when the file has
 * none, which is where the schema lists it. The rest of the file keeps its
 * bytes. Throws a HandlerError for a file it cannot read, one that types `id`
 * or `hash`, and one that names its own agent or claims `source: run`.
 */
export function stampProposalProvenance(
  path: string,
  text: string,
  provenance: ProposalProvenance,
): string {
  const split = splitRecordFile(text);
  if (!split.ok) {
    throw refuse(
      "conflict",
      "record_unreadable",
      `${path} line ${split.issue.line ?? 1}: ${split.issue.message}. Oxagen writes provenance into the frontmatter, so it has to read it.`,
    );
  }
  const { frontmatter, body } = split.parts;
  // Line 1 is the first frontmatter line, so a key's line indexes `lines`.
  const parsed = parseFrontmatter(frontmatter, 1);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    throw refuse(
      "conflict",
      "record_unreadable",
      `${path} line ${(issue?.line ?? 0) + 1}: ${issue?.message ?? "the frontmatter does not read"}. Oxagen writes provenance into the frontmatter, so it has to read it.`,
    );
  }
  const { value, key_lines } = parsed.frontmatter;
  const claimed = value.provenance;
  if (isObject(claimed) && ("agent" in claimed || claimed.source === "run")) {
    throw refuse(
      "forbidden",
      "provenance_claimed",
      `${path} sets ${"agent" in claimed ? "provenance.agent" : "provenance.source: run"}. Oxagen writes the proposing agent from your run, and only the curator writes source: run. Remove provenance from the record.`,
    );
  }
  const typed = ["id", "hash"].filter((key) => key in value);
  if (typed.length > 0) {
    throw refuse(
      "conflict",
      "record_identity_typed",
      `${path} types ${typed.join(" and ")}. Oxagen writes id and hash when the steering PR merges. Remove ${typed.length === 1 ? "that line" : "those lines"}.`,
    );
  }

  const lines = frontmatter.split("\n");
  const starts = [...key_lines.values()].sort((a, b) => a - b);
  /**
   * The 1-based lines a top-level key spans: its own line and every line
   * before the next key, so a comment inside its value goes with it.
   */
  const span = (key: string): { start: number; end: number } | null => {
    const start = key_lines.get(key);
    if (start === undefined) return null;
    const next = starts.find((line) => line > start) ?? lines.length + 1;
    return { start, end: next - 1 };
  };
  const block = stringify(
    { provenance: { source: "proposal", uri: provenance.uri, agent: provenance.agent } },
    { lineWidth: 0 },
  )
    .trimEnd()
    .split("\n");
  const old = span("provenance");
  const after = span("origin");
  let out: string[];
  if (old !== null) {
    out = [...lines.slice(0, old.start - 1), ...block, ...lines.slice(old.end)];
  } else if (after !== null) {
    out = [...lines.slice(0, after.end), ...block, ...lines.slice(after.end)];
  } else {
    out = [...lines, ...block];
  }
  return `---\n${out.join("\n")}\n---\n${body}`;
}

// ── The branch ───────────────────────────────────────────────────────────────

/** The longest a branch's slug may be. */
const SLUG_MAX = 60;

/** A git-safe slug for the thing the first file changes: a lineage, a server, an agent, or a file name. */
function slugOf(path: string): string {
  const parts = path.split("/");
  let name: string;
  if (path.startsWith(`${SKILLS_DIR}/`) && parts.length > 3) {
    name = parts[2] as string;
  } else if (path.startsWith(`${TOOL_SERVERS_DIR}/`) && parts.length > 3) {
    name = parts[2] as string;
  } else {
    const file = parts[parts.length - 1] as string;
    const dot = file.lastIndexOf(".");
    name = dot > 0 ? file.slice(0, dot) : file;
  }
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .slice(0, SLUG_MAX)
    .replace(/^[.-]+|[.-]+$/g, "");
  return slug === "" ? "change" : slug;
}

/** `20261002t153012`: the UTC time to the second, as tools sync branches spell it. */
function stampOf(at: Date): string {
  return at
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .toLowerCase();
}

/**
 * The branch a proposal opens on: `<folder>/propose-<what>-<time>`, such as
 * steering/propose-aintel.billing.refunds-over-100-20261002t153012. Throws a
 * HandlerError when a path belongs under no folder a steering PR may change,
 * or when the files span more than one folder.
 */
export function proposalBranch(paths: readonly string[], at: Date): string {
  const sorted = [...paths].sort();
  const prefixes = new Set<string>();
  for (const path of sorted) {
    const prefix = branchPrefixForPath(path);
    if (prefix === null) {
      throw refuse(
        "conflict",
        "branch_scope",
        `${path} is outside every folder a steering PR may change: steering/, tools/, agents/, policy/, or the repository root.`,
      );
    }
    prefixes.add(prefix);
  }
  if (prefixes.size > 1) {
    const folders = [...prefixes].sort().map((prefix) => `${prefix}/`);
    throw refuse(
      "conflict",
      "branch_scope",
      `The files belong on ${folders.join(" and ")} branches, and one steering PR changes one folder. Propose each folder's files in its own call.`,
    );
  }
  const [prefix] = [...prefixes];
  return `${prefix as string}/propose-${slugOf(sorted[0] as string)}-${stampOf(at)}`;
}

// ── The managed block ────────────────────────────────────────────────────────

/** The files that carry a managed block. */
const MANAGED_FILES: ReadonlySet<string> = new Set([AGENTS_MD_PATH, CLAUDE_MD_PATH, README_PATH]);

const RESTORE =
  "Keep the block between the oxagen:begin and oxagen:end markers as the production branch holds it, and put your own text outside it.";

/**
 * Why the files change a managed block, or null. `read` answers the file on
 * the commit the steering checks compare against. The rule is the `owned`
 * check's: a removed file or block, a block whose text no longer matches its
 * hash, and a block whose text differs from the production one are refused.
 */
export async function managedBlockRefusal(
  read: (path: string) => Promise<string | null>,
  files: readonly ToolsPullRequestFile[],
): Promise<Refusal | null> {
  for (const file of files) {
    if (!MANAGED_FILES.has(file.path)) continue;
    const before = await read(file.path);
    const prior = before === null ? null : readManagedBlock(before);
    const priorBlock = prior?.ok ? prior.block : null;
    const refusal = (message: string): Refusal => ({
      reason: "managed_block_owned",
      message: `${message} Only Oxagen writes that block. ${RESTORE}`,
    });
    if (file.content === null) {
      if (priorBlock !== null) {
        return refusal(`Deleting ${file.path} removes the managed block in it.`);
      }
      continue;
    }
    const after = readManagedBlock(file.content);
    if (!after.ok) {
      return refusal(`${file.path} line ${after.issue.line ?? 1}: ${after.issue.message}.`);
    }
    const block = after.block;
    if (block === null) {
      if (priorBlock !== null) return refusal(`The new ${file.path} has no managed block.`);
      continue;
    }
    if (!block.intact) {
      return refusal(`The managed block in ${file.path} was edited, so its text no longer matches the hash on its begin marker.`);
    }
    if (priorBlock !== null && priorBlock.content !== block.content) {
      return refusal(`The managed block in ${file.path} differs from the one on the production branch.`);
    }
  }
  return null;
}

// ── The pull request ─────────────────────────────────────────────────────────

/** An agent's proposal: the files, the branch rule every steering PR keeps, and the managed block rule. */
export const PROPOSAL_PULL_REQUEST: SteeringPullRequestKind = {
  reasonPrefix: "propose",
  noun: "proposed steering PR",
  refusal: steeringFilesRefusal,
  refusalAgainstBase: (read, args) => managedBlockRefusal(read, args.files),
  // The PR's proposal row, so a person merges it from Oxagen (#5122, ADR-265).
  proposalKind: "agent_proposal",
};

/** The opener over the workspace's steering host and published index, with the proposal's rules. */
export const proposalPullRequestOpener: ToolsPullRequestOpener =
  createSteeringPullRequestOpener(
    workspaceSteeringPullRequestDeps,
    PROPOSAL_PULL_REQUEST,
  );

/** The frame reference a run's frame number makes, as memory evidence spells it. */
export function proposalFrameRef(run: string, frame: number): string {
  return `frame:${run}/${frame}`;
}

/** The PR body: who proposed it, why, the frames it cites, and each file it writes or deletes. */
export function proposalPullRequestBody(args: {
  agent: string;
  run: string;
  rationale: string;
  evidence: readonly number[];
  files: readonly ToolsPullRequestFile[];
}): string {
  const lines = [
    `The agent \`${args.agent}\` proposed this change from run \`${args.run}\` through Oxagen. Nothing in it steers an agent until it merges.`,
    "",
    "## Rationale",
    "",
    args.rationale,
    "",
  ];
  if (args.evidence.length > 0) {
    lines.push("## Evidence", "");
    for (const frame of args.evidence) lines.push(`- \`${proposalFrameRef(args.run, frame)}\``);
    lines.push("");
  }
  lines.push("## Files", "", "| Path | Change |", "|---|---|");
  for (const file of args.files) {
    lines.push(`| \`${file.path}\` | ${file.content === null ? "delete" : "write"} |`);
  }
  lines.push("");
  return lines.join("\n");
}
