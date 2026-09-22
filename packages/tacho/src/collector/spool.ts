/**
 * The shipper (spec section 3.1 step 3): drains unshipped WAL events to
 * `ingest_tacho_events` in batches, at least once, with exponential backoff
 * on transport or body-read failure and bisection on a refused batch so one bad event
 * cannot block a session's chain forever. Every accepted response's control
 * envelope goes to the daemon through `onControl`.
 *
 * Frame bodies ship in the same batch as their events, never a later one:
 * the control plane refuses a body whose event it did not receive in the
 * same request. A batch is therefore cut at the event that would take the
 * encoded request past `TACHO_MAX_REQUEST_BYTES`, and a bisected half carries
 * exactly the bodies of the events in it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TachoEvent } from "../envelope";
import {
  ControlError,
  ControlUnreachable,
  type ControlClient,
  type RateLimitHint,
} from "../host/control-client";
import { ensureDir, writeSensitiveFileAtomic } from "../host/fs";
import { contentClassOf, retentionAllows } from "../evidence/frame-body";
import type { RetentionMandate } from "../evidence/retention";
import type { Wal } from "../host/wal";
import {
  type ControlEnvelope,
  type DaemonHealth,
  TACHO_MAX_BATCH,
  TACHO_MAX_REQUEST_BYTES,
  TACHO_REQUEST_ENVELOPE_BYTES,
  type TachoBody,
} from "../wire";

/**
 * The retention clause in force, and whether it is the workspace's own answer.
 *
 * The two halves are one value because they are one decision and a caller
 * that could answer them separately could answer them inconsistently. That is
 * the shape of an earlier defect on this path, where four sites built the same
 * request by hand and one field reached three of them.
 */
export interface RetentionDecision {
  /** The classes whose content may leave this host right now. */
  mandate: RetentionMandate;
  /**
   * Whether `mandate` is what the workspace decided, rather than the absence
   * of an answer. False when the cached bundle does not verify or has outlived
   * its signed window: `mandate` is then `NO_RETENTION` because nothing can be
   * shown to be covered, which is not the same as the workspace having
   * narrowed it.
   *
   * Both withhold. Only a proven narrowing also purges, because a purge is
   * irreversible and an unprovable mandate is usually transient — a control
   * plane outage lapses every cached bundle at once, and destroying the queued
   * evidence of every session on that signal would make an outage into
   * permanent data loss committed by the component whose job is the record.
   */
  proven: boolean;
}

export interface ShipperOptions {
  wal: Wal;
  client: ControlClient;
  quarantineDir: string;
  health: () => DaemonHealth;
  onControl: (control: ControlEnvelope) => void | Promise<void>;
  onChainBreak?: (
    breaks: Array<{ session_uuid: string; at_seq: number; reason: string }>,
  ) => void;
  /** Bodies the control plane refused; the events themselves were accepted. */
  onBodyRejection?: (
    rejections: Array<{ event_id_idem: string; reason: string }>,
  ) => void;
  /**
   * The retention clause in force right now, asked at ship time.
   *
   * Retention is applied when a body is appended, but a body can wait in the
   * WAL through an outage and leave under a mandate that has since narrowed.
   * The control plane refuses it, which protects the record and not the
   * machine: by then the prompt or tool content has already left. So the
   * clause is asked again here, against the mandate the last refresh
   * established, and a body it no longer covers is never transmitted.
   *
   * A body the clause no longer covers is also purged from the WAL when the
   * clause is `proven`, because withholding alone leaves the bytes on disk
   * until the session seals and ages out.
   *
   * Required, and deliberately. An optional clause that a caller may omit is
   * the same bypass in a new shape: the filter would read `undefined` and
   * transmit every queued body, and a shipper built without it would look
   * correct at the call site. A caller with no trustworthy mandate to offer
   * passes `NO_RETENTION` with `proven: false`, which keeps nothing and
   * destroys nothing, rather than passing nothing.
   */
  retentionInForce: () => RetentionDecision;
  log: (line: string) => void;
  now: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * This host's current enrollment id. Events recorded under a PREVIOUS
   * enrollment can never be accepted — the control plane rejects a whole batch
   * with 403 "event names another host" if any event in it names a different
   * one — so they are quarantined here rather than shipped. Optional so an
   * existing caller that does not set it keeps the old behaviour.
   */
  hostEnrollmentId?: string;
}

export interface ShipResult {
  shipped: number;
  quarantined: number;
  reachable: boolean;
}

/** Persisted event time bounds withholding across daemon restarts. */
export const MAX_BODY_AUTHORITY_WAIT_MS = 24 * 60 * 60_000;

/**
 * The least time between two "retention: held" lines from one shipper.
 *
 * The hold is a zero-progress path: while a mandate is unproven, every drain
 * withholds the same events and finds the same nothing to ship, and the drain
 * runs on the default one-second control tick. Logging each one put 86,400
 * identical lines per host per day into the daemon log during an outage of the
 * control plane, which is the log growth this path exists to survive. The
 * ceiling is one line per five minutes, and the mark clears the moment the
 * mandate proves, so the next hold says so at once.
 */
export const RETENTION_HOLD_LOG_INTERVAL_MS = 5 * 60_000;

/**
 * The wait the server asked for, in milliseconds, or undefined when it gave no
 * usable hint. `Retry-After` wins; `X-RateLimit-Reset` is the fallback, since a
 * fixed-window limiter is spent until the window turns over. Capped so a
 * malformed or hostile header cannot park the daemon indefinitely, and floored
 * at a second so a reset already in the past does not spin.
 *
 * Two statuses name a number. A 429 is the limiter working, and its wait
 * replaces the backoff outright. A 503 is the store refusing the write under
 * pressure (`store_overloaded`), and its wait is a floor under the backoff
 * rather than a replacement: repeated backpressure is a degrading condition,
 * so the host still escalates, and only stops coming back sooner than asked.
 */
const MAX_SERVER_REQUESTED_WAIT_MS = 5 * 60_000;
function serverRequestedWaitMs(error: ControlError): number | undefined {
  if (error.status !== 429 && error.status !== 503) return undefined;
  const hint = error.rateLimit;
  if (!hint) return undefined;
  const wait =
    hint.retryAfterMs ??
    (hint.resetAtMs === undefined ? undefined : hint.resetAtMs - Date.now());
  if (wait === undefined || !Number.isFinite(wait)) return undefined;
  return Math.min(Math.max(wait, 1_000), MAX_SERVER_REQUESTED_WAIT_MS);
}

/**
 * The bytes a value adds to the request as JSON. The route's limit counts
 * the encoded request, so a body is measured as its base64 text, not as the
 * raw bytes it decodes to.
 */
function wireByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class Shipper {
  private readonly options: ShipperOptions;
  private backoffMs: number;
  private nextAttemptAt = 0;
  private lastRetentionHoldLogAt: number | undefined;
  private consecutiveFailures = 0;
  private lastRateLimit: RateLimitHint | undefined;
  lastSuccessAt: number | undefined;
  lastError: string | undefined;

  constructor(options: ShipperOptions) {
    this.options = options;
    this.backoffMs = options.minBackoffMs ?? 2_000;
    ensureDir(options.quarantineDir);
  }

  get reachable(): boolean {
    return this.consecutiveFailures === 0 && this.lastSuccessAt !== undefined;
  }

  /** Whether backoff allows an attempt now. */
  ready(): boolean {
    return this.options.now() >= this.nextAttemptAt;
  }

  private succeed(): void {
    this.consecutiveFailures = 0;
    this.backoffMs = this.options.minBackoffMs ?? 2_000;
    this.nextAttemptAt = 0;
    this.lastSuccessAt = this.options.now();
    this.lastError = undefined;
  }

  private fail(error: unknown): void {
    this.consecutiveFailures += 1;
    this.lastError = error instanceof Error ? error.message : String(error);
    // When the server said how long to wait, wait exactly that long. Blind
    // exponential backoff against a fixed-window limiter is strictly worse in
    // both directions: it can idle 60s through a window that resets in five,
    // and — because the API caches an exhausted bucket for the rest of the
    // window — every batch of a backlog drain is refused, so the doubling runs
    // to its cap on the first drain and stays there. `Retry-After` is the
    // server telling us the one number that ends the wait.
    const told =
      error instanceof ControlError ? serverRequestedWaitMs(error) : undefined;
    if (
      told !== undefined &&
      error instanceof ControlError &&
      error.status === 429
    ) {
      this.nextAttemptAt = this.options.now() + told;
      // Do NOT escalate backoffMs here. A 429 answered on time is the limiter
      // working as designed, not a degrading control plane, and letting it
      // ratchet the blind backoff would punish a host for obeying the ceiling.
      return;
    }
    // A 503 names a wait too, but backpressure that keeps coming is the store
    // degrading, so the backoff still escalates and the server's number is
    // only a floor: never come back sooner than it asked.
    this.nextAttemptAt =
      this.options.now() + Math.max(this.backoffMs, told ?? 0);
    this.backoffMs = Math.min(
      this.backoffMs * 2,
      this.options.maxBackoffMs ?? 60_000,
    );
  }

  /**
   * Record what the control plane last said about our budget. Called for every
   * response that carried the headers, success or failure.
   */
  noteRateLimit(hint: RateLimitHint): void {
    this.lastRateLimit = hint;
  }

  private quarantine(event: TachoEvent, reason: string): void {
    const path = join(
      this.options.quarantineDir,
      `${event.session_uuid}-${String(event.seq).padStart(8, "0")}.json`,
    );
    if (!existsSync(path)) {
      writeSensitiveFileAtomic(
        path,
        JSON.stringify({ reason, event }, null, 2),
      );
    }
    this.options.wal.markShipped(event.session_uuid, event.seq);
    this.options.log(
      `quarantined ${event.session_uuid}#${event.seq}: ${reason}`,
    );
  }

  private markShipped(events: readonly TachoEvent[]): void {
    const heads = new Map<string, number>();
    for (const event of events) {
      heads.set(
        event.session_uuid,
        Math.max(heads.get(event.session_uuid) ?? -1, event.seq),
      );
    }
    for (const [session, seq] of heads)
      this.options.wal.markShipped(session, seq);
  }

  /**
   * Separate events belonging to a previous enrollment before reading bodies.
   *
   * Re-enrolling a host mints a new `host_enrollment_id` and leaves whatever is
   * still spooled stamped with the old one. The control plane rejects a batch
   * with 403 if ANY event in it names a different host, and the Shipper treats
   * 403 as retryable — correctly, since a revoked key is also a 403 — so a
   * single orphaned event at the head of the WAL wedges the queue permanently
   * and every valid event behind it stops too. Observed on a real host: five
   * enrollment ids in one WAL, 30,206 of 45,135 events unshippable, nothing
   * drained since the first re-enrollment.
   *
   * Quarantine, not silent discard: these are real recorded events and belong
   * on disk where someone can inspect them, exactly like a batch the control
   * plane refuses as malformed.
   */
  private partitionByEnrollment(batch: TachoEvent[]): {
    own: TachoEvent[];
    foreign: TachoEvent[];
  } {
    const mine = this.options.hostEnrollmentId;
    if (mine === undefined) return { own: batch, foreign: [] };
    const own: TachoEvent[] = [];
    const foreign: TachoEvent[] = [];
    for (const event of batch) {
      const stamped = event.agent?.host_enrollment_id;
      if (stamped === undefined || stamped === mine) own.push(event);
      else foreign.push(event);
    }
    return { own, foreign };
  }

  private setAsideForeignEvents(foreign: TachoEvent[]): number {
    if (foreign.length === 0) return 0;
    const mine = this.options.hostEnrollmentId;
    for (const event of foreign) {
      this.quarantine(
        event,
        `recorded under enrollment ${event.agent?.host_enrollment_id}; this host is now ${mine}`,
      );
    }
    // Advance the WAL past them, or the next read returns the same events and
    // the queue is wedged exactly as it was before this existed.
    this.markShipped(foreign);
    this.options.log(
      `quarantined ${foreign.length} event(s) from a previous enrollment`,
    );
    return foreign.length;
  }

  /**
   * Cut the batch where the encoded request would cross the route's limit.
   * Events count as well as bodies, since 200 events carry their own weight.
   * The first event always ships, whatever it weighs: a single body is
   * already capped at `TACHO_MAX_BODY_BYTES` by the recorder, and an event
   * the route still refuses comes back as a 413, which `shipBatch` handles.
   */
  private fitRequestBudget(
    batch: TachoEvent[],
    bodies: Map<string, TachoBody>,
  ): TachoEvent[] {
    const budget = TACHO_MAX_REQUEST_BYTES - TACHO_REQUEST_ENVELOPE_BYTES;
    let total = 0;
    for (let index = 0; index < batch.length; index += 1) {
      const event = batch[index] as TachoEvent;
      const body = bodies.get(event.event_id_idem);
      total += wireByteLength(event) + 1;
      if (body !== undefined) total += wireByteLength(body) + 1;
      if (total > budget && index > 0) return batch.slice(0, index);
    }
    return batch;
  }

  /** Ship one batch. Returns what moved; the caller loops. */
  async shipOnce(
    excludedSessions: Set<string> = new Set(),
  ): Promise<ShipResult> {
    if (!this.ready())
      return { shipped: 0, quarantined: 0, reachable: this.reachable };
    const batch = this.options.wal.unshipped(TACHO_MAX_BATCH, excludedSessions);
    if (batch.length === 0)
      return { shipped: 0, quarantined: 0, reachable: this.reachable };
    const { own, foreign } = this.partitionByEnrollment(batch);
    // Complete body reads before ingest or quarantine can advance any cursor.
    // `bodiesForAsync` indexes the body file off the synchronous path and
    // hands the batch back in slices, so the daemon answers `/status` and its
    // control-plane fetches while a long session's bodies are read (#3694).
    let batchBodies: TachoBody[];
    try {
      batchBodies = await this.options.wal.bodiesForAsync(own);
    } catch (error) {
      this.fail(error);
      this.options.log(`WAL body read failed: ${this.lastError ?? "unknown"}`);
      return { shipped: 0, quarantined: 0, reachable: this.reachable };
    }
    const quarantined = this.setAsideForeignEvents(foreign);
    if (own.length === 0)
      return { shipped: 0, quarantined, reachable: this.reachable };
    // Filtered against the mandate as it stands now, not as it stood when the
    // body was appended. A narrowing between those two moments is exactly the
    // case this guards: the body is dropped here rather than sent and refused
    // after it has already left the machine.
    //
    // This filter answers for the wire. The bytes on disk go below, and only
    // under a proven mandate. Bodies outside a drain's reach, whose events
    // already shipped, are swept by `Wal.purgeBodiesOutsideMandate`, which the
    // daemon calls when a replacement bundle verifies and narrows the clause.
    //
    // The class comes from the body's own event rather than from the body,
    // because the WAL stores bodies as bytes and does not persist a class.
    // `contentClassOf` is the one table that maps a frame kind to a class, so
    // asking it here cannot disagree with what the append path asked.
    const retention = this.options.retentionInForce();
    const eventOf = new Map(
      own.map((event) => [event.event_id_idem, event] as const),
    );
    const allowed: TachoBody[] = [];
    const withdrawn: TachoEvent[] = [];
    for (const body of batchBodies) {
      const event = eventOf.get(body.event_id_idem);
      const contentClass =
        event === undefined ? undefined : contentClassOf(event.kind);
      // A body whose event is not in this batch, or whose kind names no
      // class, is not shipped: an unclassifiable body cannot be shown to
      // be covered, and the boundary fails closed.
      if (
        retention.proven &&
        contentClass !== undefined &&
        retentionAllows(retention.mandate, contentClass)
      ) {
        allowed.push(body);
        continue;
      }
      if (event !== undefined) withdrawn.push(event);
    }
    // Leaving the body out of the request protects the network boundary and
    // nothing else: `markShipped` advances a cursor, and `Wal.compact` frees
    // body bytes only once a sealed session has aged out, so an unsealed
    // session would keep the withdrawn content on disk indefinitely. The
    // narrowed mandate reaches the disk here, as the spec requires.
    //
    // Only a proven mandate purges. An unverifiable or lapsed bundle also
    // withholds, but keeps: that condition is usually transient and a purge
    // is not. A control plane outage lapses every cached bundle at once, so
    // purging on it would destroy the queued evidence of every session on
    // this host.
    if (retention.proven && withdrawn.length > 0) {
      const dropped = this.options.wal.dropBodies(withdrawn);
      if (dropped > 0)
        this.options.log(
          `retention: dropped ${String(dropped)} body(ies) the mandate no longer covers`,
        );
    }
    const held = new Map<string, number>();
    let released = 0;
    if (!retention.proven) {
      for (const event of withdrawn) {
        const age = this.options.now() - Date.parse(event.ts);
        if (
          Number.isFinite(age) &&
          age >= 0 &&
          age < MAX_BODY_AUTHORITY_WAIT_MS
        ) {
          held.set(
            event.session_uuid,
            Math.min(held.get(event.session_uuid) ?? Infinity, event.seq),
          );
          excludedSessions.add(event.session_uuid);
        } else released += 1;
      }
    }
    // Ingest requires a dense chain. Hold the suffix too, but keep other
    // sessions moving even when this session fills the WAL read limit.
    const ready = own.filter(
      (event) => event.seq < (held.get(event.session_uuid) ?? Infinity),
    );
    if (
      held.size > 0 &&
      (this.lastRetentionHoldLogAt === undefined ||
        this.options.now() - this.lastRetentionHoldLogAt >=
          RETENTION_HOLD_LOG_INTERVAL_MS)
    ) {
      this.lastRetentionHoldLogAt = this.options.now();
      this.options.log(
        `retention: held ${own.length - ready.length} event(s) in ${held.size} session(s): body authority unproven`,
      );
    }
    if (retention.proven) this.lastRetentionHoldLogAt = undefined;
    if (released > 0)
      this.options.log(
        `retention: releasing ${released} event(s) body-missing: unproven authority exceeded the 24-hour event-age ceiling or event time is invalid`,
      );
    if (ready.length === 0) {
      const next = await this.shipOnce(excludedSessions);
      return { ...next, quarantined: next.quarantined + quarantined };
    }
    const bodies = new Map(
      allowed.map((body) => [body.event_id_idem, body] as const),
    );
    const result = await this.shipBatch(
      this.fitRequestBudget(ready, bodies),
      bodies,
    );
    return { ...result, quarantined: result.quarantined + quarantined };
  }

  private async shipBatch(
    batch: TachoEvent[],
    bodies: ReadonlyMap<string, TachoBody>,
  ): Promise<ShipResult> {
    try {
      const shipped: TachoBody[] = [];
      for (const event of batch) {
        const body = bodies.get(event.event_id_idem);
        if (body !== undefined) shipped.push(body);
      }
      const response = await this.options.client.ingest(
        batch,
        this.options.health(),
        shipped,
      );
      this.markShipped(batch);
      this.succeed();
      if (response.chain_breaks.length > 0)
        this.options.onChainBreak?.(response.chain_breaks);
      if (
        response.body_rejections !== undefined &&
        response.body_rejections.length > 0
      )
        this.options.onBodyRejection?.(response.body_rejections);
      await this.options.onControl(response.control);
      return { shipped: batch.length, quarantined: 0, reachable: true };
    } catch (error) {
      if (error instanceof ControlUnreachable) {
        this.fail(error);
        return { shipped: 0, quarantined: 0, reachable: false };
      }
      if (error instanceof ControlError && error.status === 413) {
        // The request was too large, which retrying cannot change. Bisect
        // until it fits. A lone event that is still too large ships without
        // its body, so the event and its chain survive, and is quarantined
        // only if the event alone is refused.
        const head = batch[0] as TachoEvent;
        if (batch.length === 1 && bodies.has(head.event_id_idem)) {
          this.options.log(
            `shipping ${head.session_uuid}#${head.seq} without its body: request too large`,
          );
          return this.shipBatch(batch, new Map());
        }
      }
      if (
        error instanceof ControlError &&
        (error.status === 400 || error.status === 413 || error.status === 422)
      ) {
        // The control plane refused the batch: malformed (400, 422), or too
        // large for one request (413). Bisect to the event it objects to; a
        // single refused event is quarantined.
        //
        // 413 belongs here and not with the retryable refusals below. The
        // ingest route caps a request at `TACHO_MAX_REQUEST_BYTES`, and a
        // retry can never make a batch smaller, so keeping it means offering
        // the same oversized request on every drain for ever. Because the
        // WAL head never advances past it, every later event on that host
        // queues behind it and the evidence pipeline stops permanently,
        // while the host still reports itself healthy. Bisection halves the
        // batch until the request fits, and an event that exceeds the limit
        // on its own is quarantined rather than retried, which is the same
        // answer this path already gives a malformed event.
        if (batch.length === 1) {
          this.quarantine(batch[0] as TachoEvent, error.body.slice(0, 512));
          this.succeed();
          return { shipped: 0, quarantined: 1, reachable: true };
        }
        const middle = Math.ceil(batch.length / 2);
        const leftHalf = batch.slice(0, middle);
        const left = await this.shipBatch(leftHalf, bodies);
        if (left.shipped + left.quarantined < leftHalf.length) return left;
        const right = await this.shipBatch(batch.slice(middle), bodies);
        return {
          shipped: left.shipped + right.shipped,
          quarantined: left.quarantined + right.quarantined,
          reachable: left.reachable && right.reachable,
        };
      }
      // 401/403 (revoked or denied key), 429, 5xx: keep the batch, back off.
      this.fail(error);
      this.options.log(`ingest failed: ${this.lastError ?? "unknown"}`);
      return {
        shipped: 0,
        quarantined: 0,
        reachable: !(error instanceof ControlUnreachable),
      };
    }
  }

  /**
   * Stop draining when the control plane has said this window is spent.
   *
   * `drain()` loops until the WAL is empty, which is right for a few queued
   * events and wrong for a backlog: 45,000 spooled events are 226 batches, and
   * firing them back to back spends a per-minute ceiling in seconds and earns
   * a 429 for every batch after it. The server already reports what is left on
   * every counted response, so pace against that number rather than
   * rediscovering the ceiling by being refused. Nothing here hardcodes the
   * ceiling: a server that sends no headers drains exactly as before.
   */
  private windowSpent(): boolean {
    const hint = this.lastRateLimit;
    if (!hint || hint.remaining === undefined || hint.remaining > 0)
      return false;
    if (hint.resetAtMs !== undefined) {
      // Hold off until the window turns over, then let the loop resume.
      this.nextAttemptAt = Math.max(this.nextAttemptAt, hint.resetAtMs);
    }
    return true;
  }

  /** Ship until the WAL is drained, the window is spent, or a failure stops the loop. */
  async drain(): Promise<ShipResult> {
    const total: ShipResult = {
      shipped: 0,
      quarantined: 0,
      reachable: this.reachable,
    };
    for (;;) {
      const result = await this.shipOnce();
      total.shipped += result.shipped;
      total.quarantined += result.quarantined;
      total.reachable = result.reachable;
      if (result.shipped + result.quarantined === 0) return total;
      if (this.windowSpent()) return total;
    }
  }
}
