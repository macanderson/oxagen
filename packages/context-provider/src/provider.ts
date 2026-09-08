/**
 * The Context Exchange Provider — oxagen's memory, served over the Context
 * Graph Protocol.
 *
 * A host asks for context relevant to a goal; this answers with frames drawn
 * from one workspace's engram records, budgeted and carrying their provenance.
 * It is scoped to exactly one workspace at construction: the protocol carries
 * no tenant, so a provider that could reach two workspaces would have no way
 * to be told which one a query meant, and the safe reading of that ambiguity
 * is the one that never happens.
 *
 * ## What it declares, and why each is true
 *
 * - `correlation: true` — the SDK's stdio runtime echoes a query's `id` on the
 *   reply. This is the runtime's guarantee, not a claim of its own.
 * - `verify: true` — records are content-addressed, so "is this frame still
 *   good?" is answerable without re-reading the world.
 * - `graph: false` — `entity` and `edge` records are served as `graph` frames,
 *   but the capability means graph *traversal*, which this does not do.
 * - `embeddings_fingerprint: null` — records may carry a quantized embedding,
 *   and this provider does not rank with it. Naming a fingerprint would invite
 *   a host to compare its own vectors against one that never ran.
 * - `resolve: false` — every frame is `full`, so there is no reference to
 *   resolve.
 */
import type {
  Capabilities,
  ContextQuery,
  ContextQueryResult,
  FrameKind,
  Provider,
  ProviderInfo,
  VerifyRequest,
  VerifyResponse,
  FrameVerdict,
} from "@contextgraphprotocol/typescript-sdk";
import type { MemoryRecord, Namespace, RecordKind } from "@oxagen/engram";
import type { EpisodicStore } from "@oxagen/engram/store";
import { packWithinBudget } from "./budget";
import { contentDigest, renderContent, toFrame } from "./frames";
import { recordKindsFor, SERVED_FRAME_KINDS } from "./kinds";

/** The provider id this serves under, and the one `verify` answers for. */
export const PROVIDER_NAME = "oxagen-context-exchange";

export interface ContextProviderOptions {
  /** The single workspace this provider serves. */
  namespace: Namespace;
  store: EpisodicStore;
  /** Reported at handshake. Defaults to the package's own version. */
  version?: string;
  /**
   * How many records to consider per requested frame.
   *
   * The budget drops frames that do not fit, so fetching exactly `max_frames`
   * would leave the budget short by however many were dropped. Considering a
   * few times more gives the packer something to fall back on without turning
   * every query into a table scan.
   */
  candidateMultiplier?: number;
}

const DEFAULT_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_VERSION = "0.1.0";

/** Build a CGP provider over one workspace's engram store. */
export function createContextProvider(
  options: ContextProviderOptions,
): Provider {
  const {
    namespace,
    store,
    version = DEFAULT_VERSION,
    candidateMultiplier = DEFAULT_CANDIDATE_MULTIPLIER,
  } = options;

  function info(): ProviderInfo {
    return {
      name: PROVIDER_NAME,
      version,
      // Reads the local store, writes nothing, and sends nothing anywhere. A
      // query never leaves the process it runs in.
      data_flow: {
        reads: true,
        writes: false,
        egress: false,
        egress_scopes: ["local-only"],
      },
    };
  }

  function capabilities(): Capabilities {
    return {
      query: { kinds: [...SERVED_FRAME_KINDS] },
      correlation: true,
      graph: false,
      embeddings_fingerprint: null,
      verify: true,
      representations: ["full"],
      resolve: false,
    };
  }

  async function query(request: ContextQuery): Promise<ContextQueryResult> {
    const kinds = selectRecordKinds(request.kinds);
    // A kind filter naming nothing this provider serves selects no records.
    // Answering it with everything would be worse than answering it empty.
    if (kinds.length === 0) return { frames: [], truncated: false };

    const maxFrames = Math.max(0, Math.floor(request.max_frames));
    const maxTokens = Math.max(0, Math.floor(request.max_tokens));
    if (maxFrames === 0 || maxTokens === 0) {
      return { frames: [], truncated: false };
    }

    const candidates = Math.max(maxFrames, maxFrames * candidateMultiplier);
    const asOf = parseAsOf(request.as_of);
    const scored = await gatherCandidates({
      store,
      namespace,
      request,
      kinds,
      candidates,
      asOf,
    });

    const frames = scored.map(({ record, score }) => toFrame(record, score));
    return packWithinBudget(frames, { maxFrames, maxTokens });
  }

  /**
   * Revalidate frames a host already holds.
   *
   * Answered on `frame_id` alone. `provider_id` is the HOST's name for this
   * provider, not this provider's name for itself — the reference host labels
   * a provider under test `provider-under-test` regardless of what `info()`
   * returned. This used to compare that field against `PROVIDER_NAME` and
   * report `unknown` when it differed, which meant declining to vouch for
   * every frame it had just served. The upstream conformance suite's
   * `verify-honesty` check is what caught it.
   *
   * A host routes a verify request to the provider that issued the frames, so
   * an id here is one this provider is being asked about. Not holding it means
   * the record is gone, which is a different answer from declining.
   */
  async function verify(request: VerifyRequest): Promise<VerifyResponse> {
    const records = await store.getByIds(
      request.frames.map((frame) => frame.frame_id),
    );
    const byId = new Map(records.map((record) => [record.id, record]));

    const verdicts: FrameVerdict[] = request.frames.map((frame) => {
      const record = byId.get(frame.frame_id);
      if (!record) return { frame, status: "gone" };

      const current = contentDigest(renderContent(record.body));
      // A request with no digest is asking whether the record still exists,
      // which it does.
      if (!frame.content_digest) return { frame, status: "valid" };
      if (frame.content_digest === current) return { frame, status: "valid" };
      return { frame, status: "stale", replacement_digest: current };
    });

    return { verdicts };
  }

  return { info, capabilities, query, verify };
}

function selectRecordKinds(
  kinds: readonly FrameKind[] | undefined,
): RecordKind[] {
  if (!kinds || kinds.length === 0) {
    return recordKindsFor(SERVED_FRAME_KINDS);
  }
  return recordKindsFor(kinds);
}

/** `as_of` in ms, or undefined when absent or unparseable. */
function parseAsOf(asOf: string | undefined): number | undefined {
  if (!asOf) return undefined;
  const ms = Date.parse(asOf);
  return Number.isNaN(ms) ? undefined : ms;
}

interface GatherArgs {
  store: EpisodicStore;
  namespace: Namespace;
  request: ContextQuery;
  kinds: RecordKind[];
  candidates: number;
  asOf: number | undefined;
}

interface ScoredRecord {
  record: MemoryRecord;
  score: number;
}

/**
 * The candidate records for a query, each with the relevance this provider
 * stands behind.
 *
 * Two routes, because the store offers two and they answer different
 * questions. With query text, lexical search scores by the fraction of query
 * terms a record matches — a real relevance signal. Without it, there is
 * nothing to be relevant *to*, so the ranking falls back to salience, which is
 * the store's own judgement of importance and is already in `[0, 1]`.
 *
 * The lexical route filters kinds and `as_of` after the fact because
 * `searchLexical` takes neither. That can return fewer than `candidates` — the
 * honest outcome, since the alternative is a second query that reorders by
 * something other than relevance.
 */
async function gatherCandidates(args: GatherArgs): Promise<ScoredRecord[]> {
  const { store, namespace, request, kinds, candidates, asOf } = args;
  const kindSet = new Set<RecordKind>(kinds);

  const text = request.query_text?.trim();
  if (text) {
    const hits = await store.searchLexical(namespace, text, candidates);
    const byId = new Map(hits.map((hit) => [hit.recordId, hit.score]));
    const records = await store.getByIds(hits.map((hit) => hit.recordId));
    return records
      .filter((record) => kindSet.has(record.kind))
      .filter((record) => withinAsOf(record, asOf))
      .map((record) => ({ record, score: byId.get(record.id) ?? 0 }));
  }

  const records = await store.query({
    namespace,
    kinds,
    limit: candidates,
    ...(asOf !== undefined ? { before: asOf } : {}),
  });
  return records.map((record) => ({ record, score: record.salience }));
}

function withinAsOf(record: MemoryRecord, asOf: number | undefined): boolean {
  return asOf === undefined || record.createdAt <= asOf;
}
