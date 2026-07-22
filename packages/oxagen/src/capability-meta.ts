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
// link). graph.node points at the node-detail route, now nested under Graph at
// /[orgSlug]/[workspaceSlug]/knowledge/graph/[nodeId] (web-app-2.0 Phase 2).
export const RECORD_LINK_ROUTES: Readonly<Record<string, string>> = {
  "graph.node": "/{orgSlug}/{workspaceSlug}/knowledge/graph/{id}",
  conversation: "/{orgSlug}/{workspaceSlug}/chat/{id}",
  // Agent detail lives at Workbench → Agents → [agentId] (segment is the agent
  // publicId, `agt_…`). Only opt-in callers that KNOW a value is an agent id
  // (e.g. the agents-list card) resolve this — `inferRecordTypeForField` still
  // never maps a bare `publicId` to "agent", so the generic fallback can't emit
  // an agent link from an ambiguous id.
  agent: "/{orgSlug}/{workspaceSlug}/workbench/agents/{id}",
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
    if (cur === null || cur === undefined || typeof cur !== "object")
      return undefined;
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
export function inferRecordTypeForField(
  field: string,
  value?: string,
): string | null {
  const f = field.toLowerCase();
  if (
    f === "nodeid" ||
    f === "fromnodeid" ||
    f === "tonodeid" ||
    f === "node_id"
  ) {
    return "graph.node";
  }
  if (
    f === "conversationid" ||
    f === "conversation_id" ||
    f === "conversationpublicid"
  ) {
    return "conversation";
  }
  // Explicit asset fields are always assets; the value isn't gated (an upstream
  // assetId field is asset-typed by contract).
  if (f === "assetid" || f === "asset_id") return "asset";
  // Ambiguous generic id: only an actual generated-asset (`gen_…`) value links.
  if (f === "publicid") {
    return value !== undefined && value.startsWith(GENERATED_ASSET_ID_PREFIX)
      ? "asset"
      : null;
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
      const labelVal = spec.labelField
        ? readOutputPath(output, spec.labelField)
        : undefined;
      links.push({
        field: spec.field,
        recordType: spec.recordType,
        id: idVal,
        href: resolveRecordHref(spec.recordType, idVal, slugs),
        label:
          typeof labelVal === "string" && labelVal.length > 0
            ? labelVal
            : idVal,
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
// HERE instead of in the contract's output. `agent.repo.edit` and
// `repo.file.put` now carry an optional `diffs` output field (per-file
// `{ path, patch, additions, deletions }`, populated by
// packages/handlers/src/agent.repo.edit.ts / repo.file.put.ts via
// packages/handlers/src/lib/unified-diff.ts) — when present, that's mapped
// straight onto the card's `files` prop so it renders full hunks; when
// absent (diff computation failed, or an older execution predates the
// field) the transforms fall back to a path-only row, same as before. See
// packages/oxagen/src/contracts/agent.repo.edit.ts and repo.file.put.ts.
// A transform returns `null` when the capability's output doesn't have
// enough shape to render (falls through to the standard hint/generic path
// below); `agent.sandbox.exec` only maps to "terminal-trace" when its
// combined stdout+stderr exceeds TERMINAL_TRACE_LINE_THRESHOLD lines —
// smaller output stays on whatever the standard path already resolves
// (today: the generic capability-result card).
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
    if (afterBlob && afterBlob.length > 0 && afterBlob !== decoded)
      return afterBlob;
    return decoded.split("/").pop() || "file";
  } catch {
    return "file";
  }
}

const STRUCTURAL_RENDER_TRANSFORMS: Readonly<
  Record<string, (output: unknown) => ResolvedRenderDirective | null>
> = {
  edit_repo_file: (output) => {
    if (!isRecord(output)) return null;
    const changedFiles = Array.isArray(output.changedFiles)
      ? output.changedFiles.filter((f): f is string => typeof f === "string")
      : [];
    if (changedFiles.length === 0) return null;
    const prUrl = typeof output.prUrl === "string" ? output.prUrl : undefined;
    const prNumber =
      typeof output.prNumber === "number" ? output.prNumber : undefined;
    // Per-file patch/stats, when the handler was able to compute them (see
    // the module comment above `STRUCTURAL_RENDER_TRANSFORMS`). Keyed by path
    // so each changedFiles entry can look up its own diff.
    const diffsByPath = new Map<string, Record<string, unknown>>();
    if (Array.isArray(output.diffs)) {
      for (const d of output.diffs) {
        if (isRecord(d) && typeof d.path === "string")
          diffsByPath.set(d.path, d);
      }
    }
    return {
      componentId: "code-diff",
      props: {
        files: changedFiles.map((path) => {
          const d = diffsByPath.get(path);
          return {
            path,
            patch: d && typeof d.patch === "string" ? d.patch : null,
            additions:
              d && typeof d.additions === "number" ? d.additions : null,
            deletions:
              d && typeof d.deletions === "number" ? d.deletions : null,
          };
        }),
        summary:
          typeof output.summary === "string" ? output.summary : undefined,
        externalUrl: prUrl,
        externalLabel:
          prUrl && prNumber !== undefined ? `PR #${prNumber}` : undefined,
      },
    };
  },
  put_repo_file: (output) => {
    if (!isRecord(output)) return null;
    const htmlUrl =
      typeof output.htmlUrl === "string" ? output.htmlUrl : undefined;
    const commitSha =
      typeof output.commitSha === "string" ? output.commitSha : undefined;
    if (!htmlUrl && !commitSha) return null;
    const diffs = Array.isArray(output.diffs)
      ? output.diffs.filter(isRecord)
      : [];
    const firstDiff = diffs[0];
    const path =
      firstDiff && typeof firstDiff.path === "string"
        ? firstDiff.path
        : derivePathFromHtmlUrl(htmlUrl);
    return {
      componentId: "code-diff",
      props: {
        files: [
          {
            path,
            patch:
              firstDiff && typeof firstDiff.patch === "string"
                ? firstDiff.patch
                : null,
            additions:
              firstDiff && typeof firstDiff.additions === "number"
                ? firstDiff.additions
                : null,
            deletions:
              firstDiff && typeof firstDiff.deletions === "number"
                ? firstDiff.deletions
                : null,
          },
        ],
        externalUrl: htmlUrl,
        externalLabel: commitSha
          ? `commit ${commitSha.slice(0, 7)}`
          : undefined,
      },
    };
  },
  run_sandbox_command: (output) => {
    if (!isRecord(output)) return null;
    const stdout = typeof output.stdout === "string" ? output.stdout : "";
    const stderr = typeof output.stderr === "string" ? output.stderr : "";
    if (
      countLines(stdout) + countLines(stderr) <=
      TERMINAL_TRACE_LINE_THRESHOLD
    )
      return null;
    return {
      componentId: "terminal-trace",
      props: {
        stdout,
        stderr,
        exitCode: typeof output.exitCode === "number" ? output.exitCode : null,
        durationMs:
          typeof output.executionMs === "number"
            ? output.executionMs
            : undefined,
        timedOut:
          typeof output.timedOut === "boolean" ? output.timedOut : false,
      },
    };
  },
  // repo.pr.get output IS the pr-stats card's props (the card interface mirrors
  // the contract output field-for-field), so this is a guarded pass-through.
  get_pr: (output) => {
    if (!isRecord(output) || typeof output.number !== "number") return null;
    return { componentId: "pr-stats", props: output };
  },
  // repo.ci.status output IS the ci-status card's props.
  get_ci_status: (output) => {
    if (!isRecord(output) || !Array.isArray(output.runs)) return null;
    return { componentId: "ci-status", props: output };
  },
  // repo.pr.diff → the existing code-diff card. Map the PR file list onto the
  // card's flat {path, patch, additions, deletions} shape; parseUnifiedDiff
  // renders full hunks from the real `patch` text.
  get_pr_diff: (output) => {
    if (!isRecord(output) || !Array.isArray(output.files)) return null;
    const files = output.files.filter(isRecord).map((f) => ({
      path: typeof f.path === "string" ? f.path : "file",
      patch: typeof f.patch === "string" ? f.patch : null,
      additions: typeof f.additions === "number" ? f.additions : null,
      deletions: typeof f.deletions === "number" ? f.deletions : null,
    }));
    if (files.length === 0) return null;
    return {
      componentId: "code-diff",
      props: {
        files,
        summary:
          typeof output.summary === "string" ? output.summary : undefined,
      },
    };
  },
};

// ── Curated render hints (prioritized capabilities) ──────────────────────────
// Each componentId is a bespoke chat component (apps/app) that reads the uniform
// envelope. Capabilities that embed their own `render` directive in the output
// (archive.create, documents.generate, graph.stats, image/video) are NOT listed
// here — the embedded directive wins upstream.
export const CURATED_RENDER_HINTS: Readonly<
  Record<string, CapabilityRenderHint>
> = {
  get_node: {
    componentId: "graph-node-card",
    recordLinks: [
      {
        field: "node.nodeId",
        recordType: "graph.node",
        labelField: "node.displayName",
      },
    ],
    titleField: "node.displayName",
  },
  list_nodes: { componentId: "graph-node-list-card" },
  search_nodes: { componentId: "graph-node-list-card" },
  get_research_status: { componentId: "research-swarm-card" },
  start_research_swarm: { componentId: "research-swarm-card" },
  list_conversations: { componentId: "conversation-list-card" },
  list_agent_defs: { componentId: "agent-definition-list-card" },
  search_web: { componentId: "web-search-card" },
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
  search_web: {
    produces: ["search.results"],
    consumes: ["query", "topic"],
    chainHints: ["generate_document"],
  },
  fetch_web_page: {
    produces: ["document.text"],
    consumes: ["url"],
    chainHints: ["generate_document"],
  },
  start_research_swarm: {
    produces: ["swarm.id"],
    consumes: ["topic"],
    chainHints: ["get_research_status"],
  },
  get_research_status: {
    produces: ["search.results", "swarm.id"],
    consumes: ["swarm.id"],
    chainHints: ["generate_document"],
  },
  get_node: {
    produces: ["graph.node"],
    consumes: ["graph.nodeId"],
    chainHints: ["list_nodes"],
  },
  search_nodes: {
    produces: ["graph.nodeId"],
    consumes: ["query"],
    chainHints: ["get_node"],
  },
  list_nodes: {
    produces: ["graph.nodeId"],
    consumes: [],
    chainHints: ["get_node"],
  },
  generate_document: {
    produces: ["asset.id"],
    consumes: ["document.text"],
    chainHints: ["create_archive"],
  },
  create_pdf: {
    produces: ["asset.id"],
    consumes: ["document.text"],
    chainHints: [],
  },
  create_archive: {
    produces: ["asset.id"],
    consumes: ["asset.id", "document.text"],
    chainHints: [],
  },
  list_conversations: {
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
    chainHints:
      cap?.chainHints ?? curated?.chainHints ?? EMPTY_CHAIN.chainHints,
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
  if (output === null || output === undefined || typeof output !== "object")
    return false;
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

  const rawTitle = hint?.titleField
    ? readOutputPath(output, hint.titleField)
    : undefined;
  const title =
    typeof rawTitle === "string" && rawTitle.length > 0 ? rawTitle : undefined;

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
