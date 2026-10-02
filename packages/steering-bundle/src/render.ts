// render.ts: what a published version sends the model (steering-repo-spec,
// Token efficiency).
//
// A record reaches the model as a heading with its label, then its body. The
// frontmatter stays home. Always-on records form one block per code
// repository, sorted by lineage, rendered once at publish and sent before
// anything that varies per request, so the provider's prompt cache bills the
// block at the cache-read price after the first request. Every other record
// and skill reaches the model as one index line, which the agent follows with
// read_steering.
import { createHash } from "node:crypto";
import { matchesGlob } from "@oxagen/glob";
import type { Bundle, BundleRecord } from "@oxagen/oxagen/steering-repo/bundle";
import { findMentions, toolTargetMatches } from "@oxagen/oxagen/steering-repo/names";
import { recordStatement } from "@oxagen/oxagen/steering-repo/record";
import { countTokens } from "@oxagen/oxagen/steering-repo/tokens";
import { renderMentions, toolModesOf, type ToolModes } from "./mentions";
import { compareText } from "./tree";

export const WORKSPACE_BLOCK_HEADING = "## Workspace rules";
export const ORGANIZATION_BLOCK_HEADING = "## Organization rules";
export const INDEX_HEADING = "## More steering";
export const INDEX_LEAD = "Read any of these with read_steering when it fits the task.";
export const REQUEST_HEADING = "## Request rules";

/** Which published version a record came from. */
export type BundleSource = "workspace" | "organization";

type Indexed = Pick<BundleRecord, "label" | "description" | "lineage">;

/** A record as the model reads it: `### <label>`, then the body with its mentions rendered. */
export function recordSection(label: string, body: string, modes: ToolModes): string {
  return `### ${label}\n${renderMentions(recordStatement(body), modes)}\n`;
}

/**
 * A record's `tokens`: its heading and body as written. The count leaves the
 * mentions unrendered, so it matches the budget check, which counts the file.
 */
export function recordTokens(label: string, body: string): number {
  return countTokens(`### ${label}\n${recordStatement(body)}\n`);
}

/** A record's one index line: `- <label>: <description> (<lineage>)`. */
export function indexLine(record: Indexed): string {
  return record.description === undefined
    ? `- ${record.label} (${record.lineage})`
    : `- ${record.label}: ${record.description} (${record.lineage})`;
}

/** A record's `index_tokens`. */
export function indexTokens(record: Indexed): number {
  return countTokens(indexLine(record));
}

/** A block of sections under one heading. A block with no sections is empty text. */
export function renderBlock(heading: string, sections: readonly string[]): string {
  return sections.length === 0 ? "" : `${heading}\n\n${sections.join("\n")}`;
}

/** The heading a version's always-on block carries. */
export function blockHeading(scope: Bundle["scope"]): string {
  return scope === "organization" ? ORGANIZATION_BLOCK_HEADING : WORKSPACE_BLOCK_HEADING;
}

// ── One request ──────────────────────────────────────────────────────────────

/** What a request is doing, as the gateway and the harness hooks report it. */
export interface RequestContext {
  /** The code repository the run works in, or null for none. */
  repository: string | null;
  /** The paths the run touched, for `load: match`. */
  files?: readonly string[];
  /** The skill the request is running, for a record's `skills` target. */
  skill?: string | null;
  /**
   * The tool names the run holds. Unset, the run holds every imported tool,
   * which is day one's rule. A record whose `tools` target matches none of
   * them stays out.
   */
  tools?: readonly string[];
}

/** The versions a request reads: the workspace's and the organization's. */
export interface Delivery {
  workspace: Bundle | null;
  organization: Bundle | null;
}

/** One thing a request received. */
export interface ManifestEntry {
  lineage: string;
  /** The body under its heading, or one index line. */
  as: "body" | "index";
  tokens: number;
  source: BundleSource;
}

/** What one request received, for the request's manifest and the run record. */
export interface SteeringManifest {
  workspace_version: number | null;
  organization_version: number | null;
  repository: string | null;
  added: ManifestEntry[];
  tokens: number;
  /** `sha256:<hex>` over the delivered text. */
  text_digest: string;
}

export interface RenderedRequest {
  /** The steering text, which starts with the part every request of the run shares. */
  text: string;
  /**
   * How many characters of `text` every request of this run shares: the
   * always-on blocks and the index. It changes only when a version publishes.
   */
  prefix_length: number;
  manifest: SteeringManifest;
}

/** Reads a record's body at its version's commit. Only a request that fires a record reads it. */
export type ReadBody = (source: BundleSource, record: BundleRecord) => Promise<string>;

interface Candidate {
  record: BundleRecord;
  source: BundleSource;
  bundle: Bundle;
}

/** The imported tool names a version's manifest lists, or null before the tools compile. */
export function importedToolNames(bundle: Pick<Bundle, "tools">): string[] | null {
  const servers: unknown = bundle.tools?.["servers"];
  if (!Array.isArray(servers)) return null;
  const names: string[] = [];
  for (const server of servers as unknown[]) {
    const { name, tools } = server as { name?: unknown; tools?: unknown };
    if (typeof name !== "string" || typeof tools !== "object" || tools === null) continue;
    for (const key of Object.keys(tools)) names.push(`${name}__${key}`);
  }
  return names;
}

/** Does every target the record names, except `skills`, fit this request? */
function reaches(
  record: BundleRecord,
  context: RequestContext,
  tools: readonly string[] | null,
): boolean {
  if (record.repos !== undefined) {
    if (context.repository === null || !record.repos.includes(context.repository)) {
      return false;
    }
  }
  if (record.tools !== undefined && tools !== null) {
    const targets = record.tools;
    if (!tools.some((name) => targets.some((target) => toolTargetMatches(target, name)))) {
      return false;
    }
  }
  return true;
}

/** The version's block for the repository, or its block for none. */
export function blockFor(
  bundle: Bundle,
  repository: string | null,
): Bundle["always_on"][number] | null {
  return (
    bundle.always_on.find((block) => block.repository === repository) ??
    bundle.always_on.find((block) => block.repository === null) ??
    null
  );
}

function fires(record: BundleRecord, files: readonly string[]): boolean {
  const globs = record.applies_to;
  if (globs === undefined) return false;
  return files.some((path) => globs.some((glob) => matchesGlob(glob, path)));
}

/**
 * The steering one model request receives, in a fixed order: the
 * organization's always-on block, the workspace's, the index of everything
 * else the run may read, and last the rules this request's files or skill
 * bring in. The first three depend only on the published versions and the
 * run, so they are the same bytes on every request of the run.
 */
export async function renderRequest(
  delivery: Delivery,
  context: RequestContext,
  readBody: ReadBody,
): Promise<RenderedRequest> {
  const added: ManifestEntry[] = [];
  const parts: string[] = [];
  const candidates: Candidate[] = [];
  const inBlock = new Set<string>();
  const mentioned = new Set<string>();

  const sources: Array<[BundleSource, Bundle | null]> = [
    ["organization", delivery.organization],
    ["workspace", delivery.workspace],
  ];
  for (const [source, bundle] of sources) {
    if (bundle === null) continue;
    const block = blockFor(bundle, context.repository);
    if (block !== null && block.text !== "") {
      // A blank line between the organization's block and the workspace's.
      parts.push(parts.length === 0 ? block.text : `\n${block.text}`);
      for (const lineage of block.lineages) inBlock.add(`${source}:${lineage}`);
      for (const mention of findMentions(block.text)) {
        if (mention.kind !== "tool") mentioned.add(mention.target);
      }
    }
    for (const record of bundle.records) candidates.push({ record, source, bundle });
  }
  // One entry per block record, in block order.
  for (const [source, bundle] of sources) {
    if (bundle === null) continue;
    const block = blockFor(bundle, context.repository);
    for (const lineage of block?.lineages ?? []) {
      const record = bundle.records.find((entry) => entry.lineage === lineage);
      added.push({ lineage, as: "body", tokens: record?.tokens ?? 0, source });
    }
  }

  const toolsOf = (bundle: Bundle): string[] | null =>
    context.tools === undefined ? importedToolNames(bundle) : [...context.tools];
  const eligible = candidates.filter(
    ({ record, source, bundle }) =>
      !inBlock.has(`${source}:${record.lineage}`) &&
      reaches(record, context, toolsOf(bundle)),
  );

  const index = eligible
    .filter(({ record }) => {
      if (record.skills !== undefined) return false;
      if (record.load === "match") return false;
      if (record.load === "mention") return mentioned.has(record.lineage);
      return true;
    })
    .sort(byLineage);
  if (index.length > 0) {
    parts.push(
      `\n${INDEX_HEADING}\n\n${INDEX_LEAD}\n${index.map(({ record }) => `${indexLine(record)}\n`).join("")}`,
    );
    for (const { record, source } of index) {
      added.push({ lineage: record.lineage, as: "index", tokens: record.index_tokens, source });
    }
  }
  const prefix = parts.join("");

  const files = context.files ?? [];
  const skill = context.skill ?? null;
  const forSkill = (record: BundleRecord) =>
    record.skills === undefined || (skill !== null && record.skills.includes(skill));
  const bodies = eligible
    .filter(({ record }) => forSkill(record))
    .filter(
      ({ record }) =>
        (record.load === "match" && fires(record, files)) ||
        (record.load === "always" && record.skills !== undefined),
    )
    .sort(byLineage);
  const lines = eligible
    .filter(
      ({ record }) =>
        record.skills !== undefined &&
        forSkill(record) &&
        (record.load === "relevant" || record.load === "mention"),
    )
    .sort(byLineage);

  let request = "";
  if (bodies.length > 0 || lines.length > 0) {
    const sections: string[] = [];
    for (const { record, source, bundle } of bodies) {
      const body = await readBody(source, record);
      sections.push(recordSection(record.label, body, toolModesOf(bundle)));
      added.push({ lineage: record.lineage, as: "body", tokens: record.tokens, source });
    }
    const listed = lines.map(({ record }) => `${indexLine(record)}\n`).join("");
    for (const { record, source } of lines) {
      added.push({ lineage: record.lineage, as: "index", tokens: record.index_tokens, source });
    }
    const joined = sections.join("\n");
    request = `\n${REQUEST_HEADING}\n\n${joined}${joined !== "" && listed !== "" ? "\n" : ""}${listed}`;
  }

  const text = prefix === "" ? request.replace(/^\n/, "") : `${prefix}${request}`;
  return {
    text,
    prefix_length: prefix.length,
    manifest: {
      workspace_version: delivery.workspace?.version ?? null,
      organization_version: delivery.organization?.version ?? null,
      repository: context.repository,
      added,
      tokens: countTokens(text),
      text_digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    },
  };
}

function byLineage(a: Candidate, b: Candidate): number {
  return (
    compareText(a.record.lineage, b.record.lineage) || compareText(a.source, b.source)
  );
}
