// `get_run`: the Run page's header and one page of frames.
//
// The header is the same row `list_runs` builds, read for one run. Frames
// come from the store that recorded the run (lib/run-read.ts): the ledger
// run's V2 events cursored on the run's decimal `run_seq`, or the wrapped
// session's hash-chained events cursored on its dense `seq`, both behind an
// opaque cursor this handler owns. Each frame carries its body reference and
// never its bytes (ADR-058; `get_run_frame_body` reads those on demand) and
// its own cost record when it carried one. A witness run answers the worker
// run it reported on as `witnessFor` (ADR-064); to an API-key caller a
// witness run is `not_found` (lib/run-read.ts). A wrapped session the
// harness titled answers that title as the run's name: it is the name the
// operator already knows the session by.
//
// A wrapped session's `place` names its repository here and not on
// `list_runs`: the session keeps only a digest of its git remote, and this
// read matches it against the workspace's connected repositories, so the Run
// header can name the repository while the work read is pending or after it
// failed.
//
// `waitMs` is the handler-side long poll (ARCHITECTURE.md §3.5): with no event
// past the cursor, the handler sleeps POLL_INTERVAL_MS at a time inside the
// tenant scope until one lands or the budget runs out. The gates and the audit
// emissions already happened, once, before this handler started.
//
// A wrapped run's subagents record on chains of their own, each numbered from
// 0 (#3823). A read pages one chain: the run's own, or the subagent chain
// `sessionUuid` names, which must be one Postgres lists under the run's root.
// Every read of a wrapped run also answers each subagent chain's head, read
// from ClickHouse, because ingest moves the Postgres `seq_count` before the
// frame is inserted there. With `chainsAfter`, the long poll also wakes when
// any head moves, so a run where only a subagent is still recording wakes a
// reader that follows the run's own chain.
import { createHash } from "node:crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import {
  RUN_CHAIN_HEADS_MAX,
  type RunChains,
  type RunFrame as RunFrameOut,
  runGet,
  type RunGetOutput,
} from "@oxagen/oxagen/contracts/run.get";
import type { RunFrame, SubagentChainRow } from "@oxagen/run-ledger";
import { selectTachoChainHeads } from "@oxagen/telemetry";
import {
  invalidCursor,
  microsString,
  runScope,
  type RunScope,
} from "./run.list";
import {
  connectedRunRepositories,
  readSessionConfig,
  readSessionTitle,
  workDigest,
} from "./lib/run-work";
import { logger } from "./logger";
import {
  defaultRunReadDeps,
  readChainFrames,
  readFrames,
  resolveRun,
  type ResolvedRun,
  type RunReadDeps,
  startCursorSeq,
} from "./lib/run-read";

/** How often the long poll re-reads the store. */
export const POLL_INTERVAL_MS = 500;

const DECIMAL = /^\d+$/;

/** The largest `run_seq` the ledger can hold: `run_seq` is a Postgres bigint. */
const RUN_SEQ_MAX = 9223372036854775807n;

/** A session uuid as Postgres and ClickHouse answer it: lowercase. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- Frame cursor ---------------------------------------------------------------------

/**
 * The cursor for a frame: its sequence, and the subagent chain it lies on
 * when it is not the run's own, wrapped so the shape stays ours. A frame on
 * the run's own chain keeps the `f:<seq>` form every earlier cursor has; a
 * subagent chain's frame is `f:<session uuid>:<seq>` (#3823).
 */
export function encodeFrameCursor(seq: string, sessionUuid?: string): string {
  const text =
    sessionUuid === undefined
      ? `f:${seq}`
      : `f:${sessionUuid.toLowerCase()}:${seq}`;
  return Buffer.from(text, "utf8").toString("base64url");
}

/** Where a frame cursor points: a chain and a sequence on it. */
export interface FramePosition {
  /** The subagent chain; null on the run's own chain. */
  sessionUuid: string | null;
  seq: string;
}

/**
 * The chain and sequence a cursor names, or null for a cursor this handler
 * did not write. The handler only mints cursors for values the bigint column
 * holds, so a decimal past int8 max is refused here; passed through, the
 * store's `::bigint` cast would raise and surface as a 500.
 */
export function decodeFramePosition(raw: string): FramePosition | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!text.startsWith("f:")) return null;
  const rest = text.slice(2);
  const split = rest.lastIndexOf(":");
  const sessionUuid = split === -1 ? null : rest.slice(0, split);
  const seq = split === -1 ? rest : rest.slice(split + 1);
  if (sessionUuid !== null && !UUID.test(sessionUuid)) return null;
  if (!DECIMAL.test(seq)) return null;
  if (seq.length > 19 || BigInt(seq) > RUN_SEQ_MAX) return null;
  return { sessionUuid, seq };
}

/**
 * The sequence a cursor on the run's own chain names, or null for any other
 * cursor: one this handler did not write, or one on a subagent chain. The
 * transcript's frame cursor and the stream resume the run's own chain.
 */
export function decodeFrameCursor(raw: string): string | null {
  const position = decodeFramePosition(raw);
  return position === null || position.sessionUuid !== null
    ? null
    : position.seq;
}

// ---- Subagent chains ------------------------------------------------------------------

const chainNotFound = () =>
  new HandlerError({ code: "not_found", reason: "chain_not_found" });

/**
 * The subagent chain a read pages, or null for the run's own chain. Omitted,
 * or the run's own session, `sessionUuid` names the run's own chain. Any
 * other session must be a chain Postgres lists under the run's root, so a
 * chain of another run is `not_found`, and so is any chain on a ledger run,
 * which records one.
 */
async function pagedChain(
  deps: Pick<RunReadDeps, "tachoChains">,
  run: ResolvedRun,
  sessionUuid: string | undefined,
): Promise<SubagentChainRow | null> {
  const wanted = sessionUuid?.toLowerCase();
  if (wanted === undefined) return null;
  if (run.source === "ledger") throw chainNotFound();
  if (wanted === run.sessionUuid.toLowerCase()) return null;
  if (deps.tachoChains === undefined) throw chainNotFound();
  const [row] = await deps.tachoChains(run.sessionUuid, {
    sessionUuids: [wanted],
    limit: 1,
  });
  if (row === undefined) throw chainNotFound();
  return row;
}

/**
 * `chains.cursor`: `h:` and the first 16 hex characters of a sha256 over
 * each chain that holds a readable frame, as `<uuid>:<last seq>` lines in
 * uuid order. It moves when a chain's head moves and when a chain gains its
 * first readable frame, and not when a chain is only registered.
 */
export function chainsCursor(
  heads: readonly { sessionUuid: string; lastSeq: string | null }[],
): string {
  const lines = heads
    .filter((head) => head.lastSeq !== null)
    .map((head) => `${head.sessionUuid}:${head.lastSeq}`)
    .sort();
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  return `h:${digest.slice(0, 16)}`;
}

/**
 * Every subagent chain under a wrapped run with its head: Postgres lists the
 * chains, and ClickHouse answers each one's last frame, so a head names a
 * frame a read can return. A chain holds its frames from seq 0 without
 * holes, so its count is its last seq plus one. The list stops at
 * RUN_CHAIN_HEADS_MAX chains and says so.
 */
async function readChainHeads(
  deps: Pick<RunGetDeps, "tachoChains" | "chainHeads">,
  rootSessionUuid: string,
): Promise<RunChains | undefined> {
  if (deps.tachoChains === undefined || deps.chainHeads === undefined)
    return undefined;
  const listed = await deps.tachoChains(rootSessionUuid, {
    limit: RUN_CHAIN_HEADS_MAX + 1,
  });
  const rows = listed.slice(0, RUN_CHAIN_HEADS_MAX);
  const read = await deps.chainHeads({
    rootSessionUuid,
    sessionUuids: rows.map((row) => row.sessionUuid),
  });
  const lastSeqOf = new Map(
    read.map((head) => [head.sessionUuid.toLowerCase(), head.lastSeq]),
  );
  const heads = rows.map((row) => {
    const last = lastSeqOf.get(row.sessionUuid.toLowerCase());
    return {
      sessionUuid: row.sessionUuid,
      parentSessionUuid: row.parentSessionUuid,
      subagentId: row.subagentId,
      subagentType: row.subagentType,
      spawnCallId: row.spawnToolUseId,
      lastSeq: last === undefined ? null : String(last),
      frameCount: last === undefined ? 0 : last + 1,
    };
  });
  return {
    cursor: chainsCursor(heads),
    heads,
    complete: listed.length <= RUN_CHAIN_HEADS_MAX,
  };
}

/**
 * The chain heads one invoke answers. A read that fails is logged once and
 * leaves `chains` out, so the page stands and a caller keeps its own
 * `chainsAfter`; the long poll then waits on frames alone.
 */
function chainWatch(
  deps: Pick<RunGetDeps, "tachoChains" | "chainHeads">,
  run: ResolvedRun,
  runId: string,
) {
  if (run.source !== "tacho") return undefined;
  const root = run.sessionUuid;
  let failed = false;
  let last: Promise<RunChains | undefined> | undefined;
  const read = (): Promise<RunChains | undefined> => {
    if (failed) return Promise.resolve(undefined);
    last = readChainHeads(deps, root).catch((err: unknown) => {
      failed = true;
      logger.warn(
        { err, runId },
        "get_run: the subagent chain heads could not be read; the page carries none",
      );
      return undefined;
    });
    return last;
  };
  return { read, latest: () => last ?? read() };
}

// ---- Frames ---------------------------------------------------------------------------

/**
 * The wire frame: the projection plus its cursor, the body as a reference. A
 * subagent chain's frame names its chain, and its cursor is on that chain.
 */
export function toFrame(frame: RunFrame): RunFrameOut {
  const chain = frame.chain?.sessionUuid;
  return {
    cursor: encodeFrameCursor(frame.seq, chain),
    seq: frame.seq,
    ...(chain === undefined ? {} : { sessionUuid: chain }),
    type: frame.type,
    stage: frame.stage,
    observedAt: frame.observedAt.toISOString(),
    digest: frame.digest,
    summary: frame.summary,
    tool: frame.identity.tool,
    toolStatus: frame.identity.toolStatus,
    approvalId: frame.identity.approvalId ?? null,
    body: {
      digest: frame.body.bodyDigest,
      bytesRef: frame.body.bodyRef,
      redactions: (frame.body.redactions ?? []).map((r) => ({
        path: r.path,
        reason: r.reason,
        originalDigest: r.original_digest,
      })),
      fidelity: frame.body.fidelity,
    },
    cost:
      frame.costMicros === null
        ? null
        : {
            micros: microsString(frame.costMicros),
            currency: "USD",
            basis: "client_attested",
          },
  };
}

// ---- Place ----------------------------------------------------------------------------

/** A connected repository, as a run's `place` names it. */
export type PlaceRepository = {
  host: string;
  owner: string;
  name: string;
  url: string;
};

/**
 * The connected repository whose remote hashes to `digest`, or null when none
 * does. The digest is the one `get_run_work` matches a checkout by.
 */
export async function readSessionRepository(
  scope: RunScope,
  digest: string,
): Promise<PlaceRepository | null> {
  const repositories = await connectedRunRepositories(scope);
  const match = repositories.find(
    (repo) => workDigest(`${repo.host}/${repo.owner}/${repo.name}`) === digest,
  );
  return match === undefined
    ? null
    : {
        host: match.host,
        owner: match.owner,
        name: match.name,
        url: match.url,
      };
}

/**
 * The session's repository for its `place`, or undefined when there is no
 * digest to match or the read failed, so the row says it was not read rather
 * than that no repository matched.
 */
function placeRepository(
  deps: Pick<RunGetDeps, "sessionRepository">,
  scope: RunScope,
  run: ResolvedRun,
  runId: string,
): Promise<PlaceRepository | null | undefined> {
  const digest =
    run.source === "tacho" ? (run.row.session.gitRemoteDigest ?? null) : null;
  if (digest === null || digest.trim() === "")
    return Promise.resolve(undefined);
  return deps.sessionRepository(scope, digest).catch((err: unknown) => {
    logger.warn(
      { err, runId },
      "get_run: the session's repository could not be read; its place names none",
    );
    return undefined;
  });
}

/**
 * The run's `place` with its repository, when the read answered. A session
 * that recorded no directory, no branch and no matching repository keeps a
 * null place.
 */
function withRepository(
  place: RunGetOutput["run"]["place"],
  repository: PlaceRepository | null | undefined,
): Pick<RunGetOutput["run"], "place"> {
  if (repository === undefined || place === undefined) return {};
  if (place === null && repository === null) return {};
  return {
    place: {
      path: place?.path ?? null,
      branch: place?.branch ?? null,
      repository,
    },
  };
}

// ---- Dependencies ---------------------------------------------------------------------

export type RunGetDeps = RunReadDeps & {
  /** The long poll's clock, injectable so a test does not wait. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The harness's latest title for a wrapped session; null when it gave none. */
  sessionTitle: typeof readSessionTitle;
  /** The session's latest effort and thinking settings. */
  sessionConfig: typeof readSessionConfig;
  /** The connected repository a session's remote digest names. */
  sessionRepository: typeof readSessionRepository;
  /**
   * Each listed subagent chain's last readable seq, from ClickHouse (#3823).
   * Absent, or without `tachoChains`, the read answers no `chains` field.
   */
  chainHeads?: typeof selectTachoChainHeads;
};

export function createRunGetHandler(
  deps: RunGetDeps,
): CapabilityHandler<typeof runGet> {
  /**
   * `moved`, when set, is checked on each tick the page comes back empty: it
   * answers whether a subagent chain moved past what the caller last saw, and
   * a move ends the wait as a frame would.
   */
  async function poll(
    run: ResolvedRun,
    after: string,
    limit: number,
    waitMs: number,
    chain: SubagentChainRow | null = null,
    moved?: () => Promise<boolean>,
  ): Promise<RunFrame[]> {
    const deadline = deps.now() + waitMs;
    for (;;) {
      const batch =
        chain === null || run.source !== "tacho"
          ? await readFrames(deps, run, after, limit)
          : await readChainFrames(deps, run.sessionUuid, chain, after, limit);
      if (batch.length > 0) return batch;
      if (moved !== undefined && (await moved())) return batch;
      const remaining = deadline - deps.now();
      if (remaining <= 0) return batch;
      await deps.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  return async (input, ctx): Promise<RunGetOutput> => {
    const position =
      input.framesAfter === undefined
        ? undefined
        : decodeFramePosition(input.framesAfter);
    if (position === null) throw invalidCursor(runGet.name);

    const run = await resolveRun(deps, ctx, input.runId);
    const chain = await pagedChain(deps, run, input.sessionUuid);
    // A cursor minted on another chain than the one read would resume a
    // different numbering, so it is refused like any cursor this read did
    // not write.
    if (
      position !== undefined &&
      position.sessionUuid !== (chain?.sessionUuid.toLowerCase() ?? null)
    )
      throw invalidCursor(runGet.name);
    const cursor = position?.seq;
    const watch = chainWatch(deps, run, input.runId);
    const chainsAfter = input.chainsAfter;
    const moved =
      watch === undefined || chainsAfter === undefined
        ? undefined
        : async () => {
            const chains = await watch.read();
            return chains !== undefined && chains.cursor !== chainsAfter;
          };
    // The title and the effort settings are ClickHouse's to give. A failed
    // read leaves the heading on the run id and the settings on what the
    // session row holds, rather than failing the page. They are read while
    // the frames are, since neither needs the other. So is the repository.
    const repository = placeRepository(deps, runScope(ctx), run, input.runId);
    const header =
      run.source === "tacho"
        ? Promise.all([
            deps.sessionTitle(run.sessionUuid).catch((err: unknown) => {
              logger.warn(
                { err, runId: input.runId },
                "get_run: the session title could not be read; the run id stands in",
              );
              return null;
            }),
            deps.sessionConfig(run.sessionUuid).catch((err: unknown) => {
              logger.warn(
                { err, runId: input.runId },
                "get_run: the session's effort settings could not be read",
              );
              return null;
            }),
          ])
        : Promise.resolve([null, null] as const);
    // One frame past the page tells a full page from the end of the recording.
    // A sealed run whose page had nothing behind it answers no cursor, because
    // nothing will ever lie past it; a live run keeps its resume point, since
    // the next frame may still arrive.
    //
    // A frame read the store refuses leaves the header standing. ClickHouse
    // refuses under its server-wide memory cap whichever query it picks, and a
    // small bounded read was the one it picked for the Run stream and the
    // assistant alike (#4243). The page comes back empty and says why, with no
    // cursor, so a caller keeps its own and nobody reads the run as sealed.
    const polled = poll(
      run,
      cursor ?? startCursorSeq(run),
      input.frameLimit + 1,
      input.waitMs,
      chain,
      moved,
    ).then(
      (batch) => ({ batch, failed: false }),
      (err: unknown) => {
        logger.warn(
          { err, runId: input.runId },
          "get_run: the run's frames could not be read; the header stands alone",
        );
        return { batch: [] as RunFrame[], failed: true };
      },
    );
    // The heads are read beside the frames. A read that waits on them answers
    // the heads its last tick read.
    const heads =
      watch === undefined
        ? Promise.resolve(undefined)
        : moved === undefined
          ? watch.read()
          : polled.then(() => watch.latest());
    const [[title, config], read, named, chains] = await Promise.all([
      header,
      polled,
      repository,
      heads,
    ]);
    const { batch } = read;
    const frames = batch.slice(0, input.frameLimit);
    const last = frames.at(-1);
    const ended =
      batch.length <= input.frameLimit && run.item.status !== "live";
    return {
      run: {
        ...run.item,
        ...(title === null ? {} : { name: title }),
        ...(config === null
          ? {}
          : {
              effort: config.effort ?? run.item.effort ?? null,
              thinking: config.thinking,
            }),
        ...withRepository(run.item.place, named),
      },
      frames: {
        frames: frames.map(toFrame),
        cursor:
          last && !ended
            ? encodeFrameCursor(last.seq, last.chain?.sessionUuid)
            : null,
      },
      witnessFor: run.witnessFor,
      ...(read.failed
        ? {
            framesError: {
              code: "frames_unavailable" as const,
              message:
                "The run's frames could not be read. The header is current. Read the run again to retry.",
            },
          }
        : {}),
      ...(chains === undefined ? {} : { chains }),
    };
  };
}

export function defaultRunGetDeps(): RunGetDeps {
  return {
    ...defaultRunReadDeps(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    sessionTitle: readSessionTitle,
    sessionConfig: readSessionConfig,
    sessionRepository: readSessionRepository,
    chainHeads: selectTachoChainHeads,
  };
}

export const runGetHandler = createRunGetHandler(defaultRunGetDeps());
