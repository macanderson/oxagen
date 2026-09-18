// `get_run_transcript`: a run read as a transcript at one zoom level
// (Mission Control spec §8.4, §14; ADR-058).
//
// The frames come from the run reader (lib/run-read.ts), are narrowed to the
// chips the caller pressed (`filterFramesByKind`), and fold into entries with
// the pure `foldTranscript` (@oxagen/run-ledger). Each entry's two halves —
// what went out and what came back — then have their bodies read from the
// evidence store, decoded as UTF-8 and cut at the contract's text cap.
//
// Two things are computed over the whole run and not over the page: the
// cumulative cost, which is a prefix sum from the run's first frame (§8.4), and
// the elapsed time, which is measured from the run's recorded start. A page
// that computed either from its own first entry would restate the run's cost
// and clock as the page's, which is wrong on every page but the first.
//
// Bodies are read a few at a time; a body that is not text, or that no longer
// hashes to its recorded digest, leaves its half with `text: null` rather than
// with bytes the record does not vouch for.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  runTranscriptGet,
  type RunTranscriptGetOutput,
  TRANSCRIPT_TEXT_MAX,
  type TranscriptEntry,
  type TranscriptEntryBody,
} from "@oxagen/oxagen/contracts/run.transcript.get";
import {
  filterFramesByKind,
  foldTranscript,
  frameKinds,
  type RunFrame,
  type TranscriptFold,
  type TranscriptKind,
} from "@oxagen/run-ledger";
import type { EvidenceStore } from "@oxagen/run-ledger/evidence-store";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { digestBytes } from "@oxagen/tacho";
import { invalidCursor, microsString, runScope, type RunScope } from "./run.list";
import {
  defaultRunReadDeps,
  readAllFrames,
  resolveRun,
  type RunReadDeps,
} from "./lib/run-read";

/** The most frames a transcript folds; past it the transcript is incomplete. */
const TRANSCRIPT_FRAME_CAP = 10_000;
/** Bodies read at once. */
const BODY_CONCURRENCY = 8;

const DECIMAL = /^\d+$/;

export type RunTranscriptGetDeps = RunReadDeps & {
  bodies: Pick<EvidenceStore, "getBody">;
};

const decoder = new TextDecoder("utf-8", { fatal: true });

// ---- Cursor ---------------------------------------------------------------------------

/** The cursor for an entry: the last frame it folded, wrapped so the shape stays ours. */
export function encodeTranscriptCursor(endSeq: string): string {
  return Buffer.from(`t:${endSeq}`, "utf8").toString("base64url");
}

/** The sequence a cursor names, or null for a cursor this handler did not write. */
export function decodeTranscriptCursor(raw: string): string | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!text.startsWith("t:")) return null;
  const seq = text.slice(2);
  return DECIMAL.test(seq) && seq.length <= 19 ? seq : null;
}

// ---- Bodies ---------------------------------------------------------------------------

/** One half of the exchange, with its body text when there is one to show. */
async function half(
  bodies: Pick<EvidenceStore, "getBody">,
  scope: RunScope,
  frame: RunFrame | null,
): Promise<TranscriptEntryBody | null> {
  if (frame === null) return null;
  const { bodyRef, bodyDigest, fidelity, redactions } = frame.body;
  const base = {
    seq: frame.seq,
    type: frame.type,
    digest: bodyDigest,
    bytesRef: bodyRef,
    redactions: (redactions ?? []).map((r) => ({
      path: r.path,
      reason: r.reason,
      originalDigest: r.original_digest,
    })),
    fidelity,
  };
  if (bodyRef === null || bodyDigest === null) {
    return { ...base, text: null, truncated: false };
  }
  const stored = await bodies.getBody(scope, bodyRef);
  if (digestBytes(stored.bytes) !== bodyDigest) {
    return { ...base, text: null, truncated: false };
  }
  let text: string;
  try {
    text = decoder.decode(stored.bytes);
  } catch {
    return { ...base, text: null, truncated: false };
  }
  return text.length > TRANSCRIPT_TEXT_MAX
    ? { ...base, text: text.slice(0, TRANSCRIPT_TEXT_MAX), truncated: true }
    : { ...base, text, truncated: false };
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

// ---- Entries --------------------------------------------------------------------------

const cost = (micros: number | null) =>
  micros === null
    ? null
    : {
        micros: microsString(micros),
        currency: "USD",
        basis: "client_attested" as const,
      };

/** Milliseconds from the run's start; never negative (see the contract). */
export function elapsedMs(startedAt: number, at: Date): number {
  return Math.max(0, Math.round(at.getTime() - startedAt));
}

/** The chips an entry answers to: the union over the frames it folds. */
function entryKinds(fold: TranscriptFold): TranscriptKind[] {
  const kinds = new Set<TranscriptKind>();
  for (const frame of [fold.opening, fold.request, fold.response]) {
    if (frame === null) continue;
    for (const kind of frameKinds(frame)) kinds.add(kind);
  }
  if (fold.decision !== null) kinds.add("policy");
  return [...kinds];
}

export function createRunTranscriptGetHandler(
  deps: RunTranscriptGetDeps,
): CapabilityHandler<typeof runTranscriptGet> {
  return async (input, ctx): Promise<RunTranscriptGetOutput> => {
    const after =
      input.after === undefined ? null : decodeTranscriptCursor(input.after);
    if (input.after !== undefined && after === null) {
      throw invalidCursor(runTranscriptGet.name);
    }

    const scope = runScope(ctx);
    const run = await resolveRun(deps, ctx, input.runId);
    const read = await readAllFrames(deps, run, TRANSCRIPT_FRAME_CAP);
    const frames = filterFramesByKind(read.frames, input.kinds);
    const folds = foldTranscript(frames, input.zoom);

    // The prefix sum runs over every fold of the run, so an entry's cumulative
    // cost is what the run had spent by then and not what this page has.
    const cumulative: (number | null)[] = [];
    let running: number | null = null;
    for (const fold of folds) {
      running =
        fold.costMicros === null ? running : (running ?? 0) + fold.costMicros;
      cumulative.push(running);
    }

    const start =
      after === null
        ? 0
        : folds.findIndex((fold) => BigInt(fold.opening.seq) > BigInt(after));
    if (start === -1) {
      return {
        zoom: input.zoom,
        kinds: input.kinds,
        entries: [],
        cursor: null,
        complete: read.complete,
      };
    }
    const page = folds.slice(start, start + input.limit);
    const runStartedAt = Date.parse(run.item.startedAt);

    const halves = await mapConcurrent(page, BODY_CONCURRENCY, async (fold) => ({
      request: await half(deps.bodies, scope, fold.request),
      response: await half(deps.bodies, scope, fold.response),
    }));

    const entries: TranscriptEntry[] = page.map((fold, i) => {
      const { opening } = fold;
      const pair = halves[i] as {
        request: TranscriptEntryBody | null;
        response: TranscriptEntryBody | null;
      };
      return {
        seq: opening.seq,
        endSeq: fold.endSeq,
        at: opening.observedAt.toISOString(),
        elapsedMs: elapsedMs(runStartedAt, opening.observedAt),
        kind: fold.kind,
        type: opening.type,
        label: opening.summary,
        kinds: entryKinds(fold),
        request: pair.request,
        response: pair.response,
        decision:
          fold.decision === null
            ? null
            : {
                seq: fold.decision.seq,
                decision: fold.decision.decision,
                type: fold.decision.type,
                at: fold.decision.at.toISOString(),
              },
        frames: fold.frames,
        cost: cost(fold.costMicros),
        cumulativeCost: cost(cumulative[start + i] ?? null),
      };
    });

    const last = page.at(-1);
    const more = start + page.length < folds.length;
    return {
      zoom: input.zoom,
      kinds: input.kinds,
      entries,
      cursor: more && last ? encodeTranscriptCursor(last.endSeq) : null,
      complete: read.complete,
    };
  };
}

export const runTranscriptGetHandler = createRunTranscriptGetHandler({
  ...defaultRunReadDeps(),
  get bodies() {
    return evidenceStore();
  },
});
