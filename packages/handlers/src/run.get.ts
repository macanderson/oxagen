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
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  type RunFrame as RunFrameOut,
  runGet,
  type RunGetOutput,
} from "@oxagen/oxagen/contracts/run.get";
import type { RunFrame } from "@oxagen/run-ledger";
import {
  invalidCursor,
  microsString,
  runScope,
  type RunScope,
} from "./run.list";
import { readStoredFit, storedFitOf } from "./lib/run-fit";
import {
  connectedRunRepositories,
  readSessionConfig,
  readSessionTitle,
  runEffortOf,
  workDigest,
} from "./lib/run-work";
import { logger } from "./logger";
import {
  defaultRunReadDeps,
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

// ---- Frame cursor ---------------------------------------------------------------------

/** The cursor for a frame: its sequence, wrapped so the shape stays ours. */
export function encodeFrameCursor(seq: string): string {
  return Buffer.from(`f:${seq}`, "utf8").toString("base64url");
}

/**
 * The sequence a cursor names, or null for a cursor this handler did not
 * write. The handler only mints cursors for values the bigint column holds,
 * so a decimal past int8 max is refused here; passed through, the store's
 * `::bigint` cast would raise and surface as a 500.
 */
export function decodeFrameCursor(raw: string): string | null {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  if (!text.startsWith("f:")) return null;
  const seq = text.slice(2);
  if (!DECIMAL.test(seq)) return null;
  if (seq.length > 19 || BigInt(seq) > RUN_SEQ_MAX) return null;
  return seq;
}

// ---- Frames ---------------------------------------------------------------------------

/** The wire frame: the projection plus its cursor, the body as a reference. */
export function toFrame(frame: RunFrame): RunFrameOut {
  return {
    cursor: encodeFrameCursor(frame.seq),
    seq: frame.seq,
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
  /** The run's stored Model fit columns (#3893); null when it has no row. */
  storedFit: typeof readStoredFit;
  /** The connected repository a session's remote digest names. */
  sessionRepository: typeof readSessionRepository;
};

export function createRunGetHandler(
  deps: RunGetDeps,
): CapabilityHandler<typeof runGet> {
  async function poll(
    run: ResolvedRun,
    after: string,
    limit: number,
    waitMs: number,
  ): Promise<RunFrame[]> {
    const deadline = deps.now() + waitMs;
    for (;;) {
      const batch = await readFrames(deps, run, after, limit);
      if (batch.length > 0) return batch;
      const remaining = deadline - deps.now();
      if (remaining <= 0) return batch;
      await deps.sleep(Math.min(POLL_INTERVAL_MS, remaining));
    }
  }

  return async (input, ctx): Promise<RunGetOutput> => {
    const cursor =
      input.framesAfter === undefined
        ? undefined
        : decodeFrameCursor(input.framesAfter);
    if (cursor === null) throw invalidCursor(runGet.name);

    const run = await resolveRun(deps, ctx, input.runId);
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
    // The Model fit reading is of a seal, so a live run reads none. A failed
    // read leaves the reading off rather than failing the page (#3893).
    const sealedAt = run.item.status === "live" ? null : run.item.sealedAt;
    const fit =
      sealedAt === null
        ? Promise.resolve(null)
        : deps
            .storedFit(
              runScope(ctx),
              run.source === "ledger"
                ? { source: "ledger", runId: run.runId }
                : { source: "tacho", publicId: run.item.id },
            )
            .then(
              (stored) => storedFitOf(stored, sealedAt),
              (err: unknown) => {
                logger.warn(
                  { err, runId: input.runId },
                  "get_run: the run's Model fit reading could not be read",
                );
                return null;
              },
            );
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
    const [[title, config], reading, read, named] = await Promise.all([
      header,
      fit,
      poll(
        run,
        cursor ?? startCursorSeq(run),
        input.frameLimit + 1,
        input.waitMs,
      ).then(
        (batch) => ({ batch, failed: false }),
        (err: unknown) => {
          logger.warn(
            { err, runId: input.runId },
            "get_run: the run's frames could not be read; the header stands alone",
          );
          return { batch: [] as RunFrame[], failed: true };
        },
      ),
      repository,
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
        // The request's own effort ahead of the harness's report, and where
        // it was read (#3891). The fit reading reads it the same way.
        ...runEffortOf(config, run.item.effort),
        ...(config === null ? {} : { thinking: config.thinking }),
        fit: reading,
        ...withRepository(run.item.place, named),
      },
      frames: {
        frames: frames.map(toFrame),
        cursor: last && !ended ? encodeFrameCursor(last.seq) : null,
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
    storedFit: readStoredFit,
    sessionRepository: readSessionRepository,
  };
}

export const runGetHandler = createRunGetHandler(defaultRunGetDeps());
