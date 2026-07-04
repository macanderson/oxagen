/**
 * Capability presentation + chaining metadata — the derivation layer that lets
 * the chat surface render EVERY capability's output as a typed React component
 * (never raw JSON) and lets the composition planner discover valid capability
 * chains.
 *
 * This module is PURE: no React, no DB, no network. The contract shapes live in
 * types.ts (CapabilityRenderHint / RecordLinkSpec / CapabilityDataTag); this
 * file holds the controlled vocabularies, the route registry, the curated
 * overrides for the prioritized capabilities, and the resolution functions.
 *
 * Resolution precedence for a render directive (see resolveRenderDirective):
 *   1. an explicit `render` directive embedded in the OUTPUT VALUE — handled by
 *      the caller (translate-stream.ts) BEFORE this module runs, so e.g.
 *      archive.create / graph.stats keep their bespoke flat-props path; then
 *   2. a contract-declared `render` hint, or the CURATED_RENDER_HINTS table; then
 *   3. the generic `capability-result` fallback with heuristic record links.
 *
 * Every synthesized component (generic AND bespoke) receives ONE uniform
 * envelope — `{ capability, output, links, title?, hideFields? }` — so a
 * bespoke graph-node card and the generic key/value card share a single
 * serializable prop shape. No per-capability mapper functions (they could not
 * live on a serializable contract).
 */
import { getCapability } from "./registry";
import type {
  CapabilityDataTag,
  CapabilityRenderHint,
  RecordLinkSpec,
} from "./types";

// ── Controlled data-tag vocabulary ───────────────────────────────────────────
// The planner matches a capability's `produces` tags against another's
// `consumes` tags. Keeping the vocabulary in one place keeps curated metadata
// honest (a typo'd tag never silently fails to chain).
export const CAPABILITY_DATA_TAGS = [
  "topic",
  "url",
  "query",
  "search.results",
  "document.text",
  "document.id",
  "asset.id",
  "graph.nodeId",
  "graph.edgeId",
  "graph.label",
  "graph.node",
  "conversation.id",
  "message.id",
  "swarm.id",
  "entity",
  "relationship",
] as const;
export type KnownDataTag = (typeof CAPABILITY_DATA_TAGS)[number];

// ── Record-link route registry ───────────────────────────────────────────────
// Maps a record type to an app route template. `{orgSlug}` / `{workspaceSlug}`
// are filled from the chat tenant context; `{id}` from the output field value.
// Only routes that genuinely resolve to an inspectable page are listed — a
// missing entry yields href:null (the id renders as plain text, not a dead
// link). graph.node points at the detail route added under
// /[orgSlug]/[workspaceSlug]/knowledge/nodes/[nodeId].
export const RECORD_LINK_ROUTES: Readonly<Record<string, string>> = {
  "graph.node": "/{orgSlug}/{workspaceSlug}/knowledge/nodes/{id}",
  conversation: "/{orgSlug}/{workspaceSlug}/chat/{id}",
  asset: "/api/v1/assets/{id}",
};

export interface SlugContext {
  orgSlug?: string;
  workspaceSlug?: string;
}

/**
 * Build the deep-link href for a record id, or null when the record type has no
 * route OR a tenant-scoped route is missing its slugs (so we never emit a
 * broken link).
 */
export function resolveRecordHref(
  recordType: string,
  id: string,
  slugs: SlugContext,
): string | null {
  const tmpl = RECORD_LINK_ROUTES[recordType];
  if (!tmpl || id.length === 0) return null;
  const needsSlugs = tmpl.includes("{orgSlug}");
  if (needsSlugs && (!slugs.orgSlug || !slugs.workspaceSlug)) return null;
  return tmpl
    .replace("{orgSlug}", encodeURIComponent(slugs.orgSlug ?? ""))
    .replace("{workspaceSlug}", encodeURIComponent(slugs.workspaceSlug ?? ""))
    .replace("{id}", encodeURIComponent(id));
}

/** Read a dot-path (e.g. "node.displayName") out of an unknown object. */
export function readOutputPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * The public-id prefix of a generated asset (`generated_assets` → idMixin("gen")).
 * Only a `gen_`-prefixed id is a real, servable asset under `/api/v1/assets/{id}`.
 */
const GENERATED_ASSET_ID_PREFIX = "gen_";

/**
 * Heuristic field-name → record-type inference, used by the generic fallback
 * when a capability declares no explicit recordLinks. Conservative: only field
 * names that unambiguously denote a linkable record map to a type.
 *
 * `publicId` is the AMBIGUOUS case — every entity (agents `agt_…`, conversations
 * `cnv_…`, mcp servers, …) carries a `publicId`, NOT just generated assets. A
 * bare field-name match therefore over-claims: it produced a dead
 * `/api/v1/assets/agt_…` deep-link for `agent.definition.*` outputs, which
 * surfaced the API's raw `{"error":{"code":"not_found","message":"Organization
 * not found"}}` JSON (the request fell through to the org-scoped API rewrite).
 * So `publicId` only maps to `asset` when its VALUE carries the generated-asset
 * `gen_` prefix; otherwise it is not a linkable asset and yields no link. Pass
 * the value when scanning a `publicId` field so the gate can apply.
 */
export function inferRecordTypeForField(field: string, value?: string): string | null {
  const f = field.toLowerCase();
  if (f === "nodeid" || f === "fromnodeid" || f === "tonodeid" || f === "node_id") {
    return "graph.node";
  }
  if (f === "conversationid" || f === "conversation_id" || f === "conversationpublicid") {
    return "conversation";
  }
  // Explicit asset fields are always assets; the value isn't gated (an upstream
  // assetId field is asset-typed by contract).
  if (f === "assetid" || f === "asset_id") return "asset";
  // Ambiguous generic id: only an actual generated-asset (`gen_…`) value links.
  if (f === "publicid") {
    return value !== undefined && value.startsWith(GENERATED_ASSET_ID_PREFIX) ? "asset" : null;
  }
  return null;
}

export interface ResolvedRecordLink {
  /** The output field (dot-path) the id was read from. */
  field: string;
  /** Record type — keys RECORD_LINK_ROUTES. */
  recordType: string;
  /** The record id value. */
  id: string;
  /** Deep-link href, or null when no route resolves. */
  href: string | null;
  /** Human label for the link (labelField value, else the id). */
  label: string;
}

/**
 * Resolve the deep links for an output. When `specs` is provided (curated /
 * declared), each spec is read by dot-path; otherwise top-level string fields
 * are scanned heuristically.
 */
export function resolveRecordLinks(
  output: unknown,
  specs: readonly RecordLinkSpec[] | undefined,
  slugs: SlugContext,
): ResolvedRecordLink[] {
  const links: ResolvedRecordLink[] = [];
  if (output === null || typeof output !== "object") return links;

  if (specs && specs.length > 0) {
    for (const spec of specs) {
      const idVal = readOutputPath(output, spec.field);
      if (typeof idVal !== "string" || idVal.length === 0) continue;
      const labelVal = spec.labelField ? readOutputPath(output, spec.labelField) : undefined;
      links.push({
        field: spec.field,
        recordType: spec.recordType,
        id: idVal,
        href: resolveRecordHref(spec.recordType, idVal, slugs),
        label: typeof labelVal === "string" && labelVal.length > 0 ? labelVal : idVal,
      });
    }
    return links;
  }

  // Heuristic fallback: scan TOP-LEVEL string fields for inferable record ids.
  for (const [key, val] of Object.entries(output as Record<string, unknown>)) {
    if (typeof val !== "string" || val.length === 0) continue;
    const recordType = inferRecordTypeForField(key, val);
    if (!recordType) continue;
    links.push({
      field: key,
      recordType,
      id: val,
      href: resolveRecordHref(recordType, val, slugs),
      label: val,
    });
  }
  return links;
}

// ── Structural render transforms (coding-agent artifact cards) ──────────────
// Every OTHER curated hint below hands its component the uniform envelope
// (`{ capability, output, links, title? }`) verbatim — the bespoke component
// (e.g. graph-node-card) parses `output` itself. `code-diff` and
// `terminal-trace` instead take FLAT, component-specific props (`{ files }` /
// `{ stdout, stderr, exitCode, … }`) — the same "embedded render directive"
// pattern archive.create/graph.stats/media use, except the reshaping happens
// HERE instead of in the contract's output. That's necessary because neither
// `agent.repo.edit` nor `repo.file.put`'s output schema carries a full
// unified-diff patch body (repo.edit exposes only changed file PATHS;
// repo.file.put exposes a commit URL) — see packages/oxagen/src/contracts/
// agent.repo.edit.ts and repo.file.put.ts. A transform returns `null` when the
// capability's output doesn't have enough shape to render (falls through to
// the standard hint/generic path below); `agent.sandbox.exec` only maps to
// "terminal-trace" when its combined stdout+stderr exceeds
// TERMINAL_TRACE_LINE_THRESHOLD lines — smaller output stays on whatever the
// standard path already resolves (today: the generic capability-result card).
const TERMINAL_TRACE_LINE_THRESHOLD = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

/**
 * Best-effort file path from a GitHub blob/commit htmlUrl — repo.file.put's
 * output carries no `path` field (it's an INPUT-only field), so this is the
 * only way to recover a human-readable label from the output alone.
 */
function derivePathFromHtmlUrl(htmlUrl: string | undefined): string {
  if (!htmlUrl) return "file";
  try {
    const decoded = decodeURIComponent(htmlUrl);
    const afterBlob = decoded.split(/\/blob\/[^/]+\//).pop();
    if (afterBlob && afterBlob.length > 0 && afterBlob !== decoded) return afterBlob;
    return decoded.split("/").pop() || "file";
  } catch {
    return "file";
  }
}

const STRUCTURAL_RENDER_TRANSFORMS: Readonly<
  Record<string, (output: unknown) => ResolvedRenderDirective | null>
> = {
  "agent.repo.edit": (output) => {
    if (!isRecord(output)) return null;
    const changedFiles = Array.isArray(output.changedFiles)
      ? output.changedFiles.filter((f): f is string => typeof f === "string")
      : [];
    if (changedFiles.length === 0) return null;
    const prUrl = typeof output.prUrl === "string" ? output.prUrl : undefined;
    const prNumber = typeof output.prNumber === "number" ? output.prNumber : undefined;
    return {
      componentId: "code-diff",
      props: {
        files: changedFiles.map((path) => ({
          path,
          patch: null,
          additions: null,
          deletions: null,
        })),
        summary: typeof output.summary === "string" ? output.summary : undefined,
        externalUrl: prUrl,
        externalLabel: prUrl && prNumber !== undefined ? `PR #${prNumber}` : undefined,
      },
    };
  },
  "repo.file.put": (output) => {
    if (!isRecord(output)) return null;
    const htmlUrl = typeof output.htmlUrl === "string" ? output.htmlUrl : undefined;
    const commitSha = typeof output.commitSha === "string" ? output.commitSha : undefined;
    if (!htmlUrl && !commitSha) return null;
    return {
      componentId: "code-diff",
      props: {
        files: [{ path: derivePathFromHtmlUrl(htmlUrl), patch: null, additions: null, deletions: null }],
        externalUrl: htmlUrl,
        externalLabel: commitSha ? `commit ${commitSha.slice(0, 7)}` : undefined,
      },
    };
  },
  "agent.sandbox.exec": (output) => {
    if (!isRecord(output)) return null;
    const stdout = typeof output.stdout === "string" ? output.stdout : "";
    const stderr = typeof output.stderr === "string" ? output.stderr : "";
    if (countLines(stdout) + countLines(stderr) <= TERMINAL_TRACE_LINE_THRESHOLD) return null;
    return {
      componentId: "terminal-trace",
      props: {
        stdout,
        stderr,
        exitCode: typeof output.exitCode === "number" ? output.exitCode : null,
        durationMs: typeof output.executionMs === "number" ? output.executionMs : undefined,
        timedOut: typeof output.timedOut === "boolean" ? output.timedOut : false,
      },
    };
  },
};

// ── Curated render hints (prioritized capabilities) ──────────────────────────
// Each componentId is a bespoke chat component (apps/app) that reads the uniform
// envelope. Capabilities that embed their own `render` directive in the output
// (archive.create, documents.generate, graph.stats, image/video) are NOT listed
// here — the embedded directive wins upstream.
export const CURATED_RENDER_HINTS: Readonly<Record<string, CapabilityRenderHint>> = {
  "graph.node.get": {
    componentId: "graph-node-card",
    recordLinks: [
      { field: "node.nodeId", recordType: "graph.node", labelField: "node.displayName" },
    ],
    titleField: "node.displayName",
  },
  "graph.node.upsert": {
    componentId: "graph-node-card",
    recordLinks: [{ field: "nodeId", recordType: "graph.node" }],
  },
  "graph.node.list": { componentId: "graph-node-list-card" },
  "graph.node.search": { componentId: "graph-node-list-card" },
  "graph.edge.upsert": { componentId: "graph-edge-card" },
  "research.swarm.status": { componentId: "research-swarm-card" },
  "research.swarm.start": { componentId: "research-swarm-card" },
  "conversation.list": { componentId: "conversation-list-card" },
  "web.search": { componentId: "web-search-card" },
};

// ── Curated chain metadata (prioritized capabilities) ────────────────────────
export interface CapabilityChainMeta {
  produces: readonly CapabilityDataTag[];
  consumes: readonly CapabilityDataTag[];
  chainHints: readonly string[];
}
const EMPTY_CHAIN: CapabilityChainMeta = Object.freeze({
  produces: [],
  consumes: [],
  chainHints: [],
});

export const CURATED_CHAIN_META: Readonly<
  Record<string, Partial<CapabilityChainMeta>>
> = {
  "web.search": {
    produces: ["search.results"],
    consumes: ["query", "topic"],
    chainHints: ["graph.node.upsert", "documents.generate"],
  },
  "web.fetch": {
    produces: ["document.text"],
    consumes: ["url"],
    chainHints: ["graph.node.upsert"],
  },
  "research.swarm.start": {
    produces: ["swarm.id"],
    consumes: ["topic"],
    chainHints: ["research.swarm.status"],
  },
  "research.swarm.status": {
    produces: ["search.results", "swarm.id"],
    consumes: ["swarm.id"],
    chainHints: ["graph.node.upsert", "graph.edge.upsert", "documents.generate"],
  },
  "graph.node.upsert": {
    produces: ["graph.nodeId"],
    consumes: ["entity", "graph.label", "document.text"],
    chainHints: ["graph.edge.upsert"],
  },
  "graph.edge.upsert": {
    produces: ["graph.edgeId"],
    consumes: ["graph.nodeId", "relationship"],
    chainHints: [],
  },
  "graph.node.get": {
    produces: ["graph.node"],
    consumes: ["graph.nodeId"],
    chainHints: ["graph.node.list"],
  },
  "graph.node.search": {
    produces: ["graph.nodeId"],
    consumes: ["query"],
    chainHints: ["graph.node.get"],
  },
  "graph.node.list": {
    produces: ["graph.nodeId"],
    consumes: [],
    chainHints: ["graph.node.get"],
  },
  "documents.generate": {
    produces: ["asset.id"],
    consumes: ["document.text"],
    chainHints: ["archive.create"],
  },
  "documents.pdf.create": {
    produces: ["asset.id"],
    consumes: ["document.text"],
    chainHints: [],
  },
  "archive.create": {
    produces: ["asset.id"],
    consumes: ["asset.id", "document.text"],
    chainHints: [],
  },
  "conversation.list": {
    produces: ["conversation.id"],
    consumes: [],
    chainHints: [],
  },
};

/**
 * Effective render hint for a capability: a contract-declared `render` wins,
 * else the curated table, else undefined (→ generic fallback).
 */
export function getRenderHint(name: string): CapabilityRenderHint | undefined {
  const declared = getCapability(name)?.render;
  if (declared) return declared;
  return CURATED_RENDER_HINTS[name];
}

/**
 * Effective chain metadata for a capability: contract-declared fields win,
 * else the curated table, else the empty chain. Every capability resolves to a
 * value (universal coverage), even if empty.
 */
export function getCapabilityChain(name: string): CapabilityChainMeta {
  const cap = getCapability(name);
  const curated = CURATED_CHAIN_META[name];
  return {
    produces: cap?.produces ?? curated?.produces ?? EMPTY_CHAIN.produces,
    consumes: cap?.consumes ?? curated?.consumes ?? EMPTY_CHAIN.consumes,
    chainHints: cap?.chainHints ?? curated?.chainHints ?? EMPTY_CHAIN.chainHints,
  };
}

export interface ResolvedRenderDirective {
  componentId: string;
  props: Record<string, unknown>;
}

/**
 * Decide whether an output is substantial enough to warrant the GENERIC
 * `capability-result` component. Trivial acks (a lone boolean, or empty) stay on
 * the compact tool-call card; anything with record links, arrays, nested
 * objects, or multiple fields gets a rendered component so the user never reads
 * a raw JSON blob.
 */
export function shouldSynthesizeComponent(
  output: unknown,
  links: readonly ResolvedRecordLink[],
): boolean {
  if (links.length > 0) return true;
  if (output === null || output === undefined || typeof output !== "object") return false;
  if (Array.isArray(output)) return output.length > 0;
  const meaningful = Object.entries(output as Record<string, unknown>).filter(
    ([k]) => k !== "render",
  );
  if (meaningful.length === 0) return false;
  if (meaningful.length === 1) {
    const value = meaningful[0]?.[1];
    // A single nested object/array is worth rendering; a lone scalar ack is not.
    return typeof value === "object" && value !== null;
  }
  return true;
}

/**
 * Resolve a render directive for a capability output that did NOT embed its own
 * `render` directive. Returns null when the output is a trivial ack with no
 * curated hint (leave it on the compact tool-call card).
 */
export function resolveRenderDirective(args: {
  capability: string;
  output: unknown;
  slugs?: SlugContext;
}): ResolvedRenderDirective | null {
  const { capability, output } = args;

  // Structural transforms (code-diff / terminal-trace) reshape the raw output
  // into flat, component-specific props and return early — they bypass the
  // uniform envelope entirely, so slugs/links/title don't apply. A `null`
  // (output doesn't have enough shape, or sandbox output is small) falls
  // through to the standard hint/generic path below.
  const structural = STRUCTURAL_RENDER_TRANSFORMS[capability]?.(output) ?? null;
  if (structural) return structural;

  const slugs = args.slugs ?? {};
  const hint = getRenderHint(capability);
  const links = resolveRecordLinks(output, hint?.recordLinks, slugs);

  if (!hint && !shouldSynthesizeComponent(output, links)) return null;

  const rawTitle = hint?.titleField ? readOutputPath(output, hint.titleField) : undefined;
  const title = typeof rawTitle === "string" && rawTitle.length > 0 ? rawTitle : undefined;

  const props: Record<string, unknown> = {
    capability,
    output,
    links,
    ...(title ? { title } : {}),
    ...(hint?.hideFields ? { hideFields: hint.hideFields } : {}),
    ...(slugs.orgSlug ? { orgSlug: slugs.orgSlug } : {}),
    ...(slugs.workspaceSlug ? { workspaceSlug: slugs.workspaceSlug } : {}),
  };

  return { componentId: hint?.componentId ?? "capability-result", props };
}
