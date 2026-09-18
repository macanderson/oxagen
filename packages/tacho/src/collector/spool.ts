/**
 * The shipper (spec section 3.1 step 3): drains unshipped WAL events to
 * `ingest_tacho_events` in batches, at least once, with exponential backoff
 * on transport failure and bisection on a refused batch so one bad event
 * cannot block a session's chain forever. Every accepted response's control
 * envelope goes to the daemon through `onControl`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TachoEvent } from "../envelope";
import type { RetentionMandate } from "../evidence/retention";
import type { BodyStore } from "../host/body-store";
import type { TachoBody } from "../wire";
import {
  ControlError,
  ControlUnreachable,
  type ControlClient,
  type RateLimitHint,
} from "../host/control-client";
import { ensureDir, writeSensitiveFileAtomic } from "../host/fs";
import type { Wal } from "../host/wal";
import {
  type ControlEnvelope,
  type DaemonHealth,
  TACHO_MAX_BATCH,
} from "../wire";

export interface ShipperOptions {
  wal: Wal;
  client: ControlClient;
  quarantineDir: string;
  health: () => DaemonHealth;
  onControl: (control: ControlEnvelope) => void | Promise<void>;
  onChainBreak?: (
    breaks: Array<{ session_uuid: string; at_seq: number; reason: string }>,
  ) => void;
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
  /**
   * The bodies this host holds, when the workspace retains them. Absent under
   * `digest_only` and on a caller that keeps none, and then every batch ships
   * events alone, exactly as before.
   */
  bodies?: BodyStore;
  /**
   * The mandate in force, read at ship time. A mandate that narrows between
   * the moment a body was written and the moment its batch drains is still
   * the one that decides, so this is a function rather than a value.
   */
  retention?: () => RetentionMandate;
}

/**
 * The most one ingest request may carry. The route refuses a larger one with
 * 413 (`apps/api/src/routes/v1/tacho.events.ingest.ts`), and a 413 is not a
 * refusal this shipper can bisect: it retries, the WAL head never advances,
 * and every later event queues behind it for ever. The budget sits under the
 * route's 1 MiB with room for the envelope and the daemon health block.
 */
const MAX_REQUEST_BYTES = 900_000;

/** An event whose frame alone overflows a request, with its size. */
export interface TooLargeEvent {
  event: TachoEvent;
  bytes: number;
}

/** What one request will carry, and what will never fit in any. */
interface FittedRequest {
  batch: TachoEvent[];
  bodies: TachoBody[];
  /** Event ids whose body alone overflows a request. */
  oversized: string[];
  /**
   * Events at the head of the queue whose frame alone overflows a request.
   * Sending one would only earn a 413, or a reset connection from a proxy
   * that reads as unreachable and is retried for ever.
   */
  tooLarge: TooLargeEvent[];
}

/**
 * Trim a batch and its bodies to what one request can hold.
 *
 * Events keep their order and the remainder ships on the next drain, so
 * nothing is lost by shipping fewer. The first event that fits always ships,
 * with its body only if the body fits too. A head event whose frame alone is
 * over the budget goes to `tooLarge` for the caller to quarantine. Either way
 * the WAL head advances, which is the wedge this exists to avoid.
 */
export function fitRequest(
  events: readonly TachoEvent[],
  held: readonly TachoBody[],
): FittedRequest {
  const bodyFor = new Map(held.map((body) => [body.event_id_idem, body]));
  const batch: TachoEvent[] = [];
  const bodies: TachoBody[] = [];
  const oversized: string[] = [];
  const tooLarge: TooLargeEvent[] = [];
  let used = 0;
  for (const event of events) {
    const body = bodyFor.get(event.event_id_idem);
    const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (batch.length === 0 && eventBytes > MAX_REQUEST_BYTES) {
      // No request can carry this frame, with or without its body. A later
      // event over the budget stops the batch below and reaches the head on
      // the next drain, so events leave the WAL in order.
      tooLarge.push({ event, bytes: eventBytes });
      continue;
    }
    const bodyBytes =
      body === undefined
        ? 0
        : Buffer.byteLength(JSON.stringify(body), "utf8") + 1;
    if (batch.length > 0 && used + eventBytes + bodyBytes > MAX_REQUEST_BYTES)
      break;
    if (batch.length === 0 && eventBytes + bodyBytes > MAX_REQUEST_BYTES) {
      // The first event must ship or the queue wedges. Its body is what
      // cannot travel, so the frame goes alone and the seal records the gap.
      batch.push(event);
      used += eventBytes;
      if (body !== undefined) oversized.push(event.event_id_idem);
      continue;
    }
    batch.push(event);
    used += eventBytes + bodyBytes;
    if (body !== undefined) bodies.push(body);
  }
  return { batch, bodies, oversized, tooLarge };
}

export interface ShipResult {
  shipped: number;
  quarantined: number;
  reachable: boolean;
}

/**
 * The wait a 429 asked for, in milliseconds, or undefined when the server gave
 * no usable hint. `Retry-After` wins; `X-RateLimit-Reset` is the fallback,
 * since a fixed-window limiter is spent until the window turns over. Capped so
 * a malformed or hostile header cannot park the daemon indefinitely, and
 * floored at a second so a reset already in the past does not spin.
 */
const MAX_SERVER_REQUESTED_WAIT_MS = 5 * 60_000;
function serverRequestedWaitMs(error: ControlError): number | undefined {
  if (error.status !== 429) return undefined;
  const hint = error.rateLimit;
  if (!hint) return undefined;
  const wait =
    hint.retryAfterMs ??
    (hint.resetAtMs === undefined ? undefined : hint.resetAtMs - Date.now());
  if (wait === undefined || !Number.isFinite(wait)) return undefined;
  return Math.min(Math.max(wait, 1_000), MAX_SERVER_REQUESTED_WAIT_MS);
}

export class Shipper {
  private readonly options: ShipperOptions;
  private backoffMs: number;
  private nextAttemptAt = 0;
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
    if (told !== undefined) {
      this.nextAttemptAt = this.options.now() + told;
      // Do NOT escalate backoffMs here. A 429 answered on time is the limiter
      // working as designed, not a degrading control plane, and letting it
      // ratchet the blind backoff would punish a host for obeying the ceiling.
      return;
    }
    this.nextAttemptAt = this.options.now() + this.backoffMs;
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
   * Quarantine events belonging to a previous enrollment, and return the rest.
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
  private setAsideForeignEvents(batch: TachoEvent[]): {
    own: TachoEvent[];
    quarantined: number;
  } {
    const mine = this.options.hostEnrollmentId;
    if (mine === undefined) return { own: batch, quarantined: 0 };
    const own: TachoEvent[] = [];
    const foreign: TachoEvent[] = [];
    for (const event of batch) {
      const stamped = event.agent?.host_enrollment_id;
      if (stamped === undefined || stamped === mine) own.push(event);
      else foreign.push(event);
    }
    if (foreign.length === 0) return { own, quarantined: 0 };
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
    return { own, quarantined: foreign.length };
  }

  /** Ship one batch. Returns what moved; the caller loops. */
  async shipOnce(): Promise<ShipResult> {
    if (!this.ready())
      return { shipped: 0, quarantined: 0, reachable: this.reachable };
    const batch = this.options.wal.unshipped(TACHO_MAX_BATCH);
    if (batch.length === 0)
      return { shipped: 0, quarantined: 0, reachable: this.reachable };
    const { own, quarantined } = this.setAsideForeignEvents(batch);
    if (own.length === 0)
      return { shipped: 0, quarantined, reachable: this.reachable };
    const result = await this.shipBatch(own);
    return { ...result, quarantined: result.quarantined + quarantined };
  }

  private async shipBatch(full: TachoEvent[]): Promise<ShipResult> {
    const held =
      this.options.bodies?.take(
        full.map((event) => event.event_id_idem),
        this.options.retention?.(),
      ) ?? [];
    const { batch, bodies, oversized, tooLarge } = fitRequest(full, held);
    const ids = batch.map((event) => event.event_id_idem);
    // A body no request can carry is dropped rather than held: it would be
    // offered on every drain and refused on every drain.
    if (oversized.length > 0) {
      this.options.bodies?.drop(oversized);
      this.options.log(
        `dropped ${oversized.length} body(ies) too large for one request`,
      );
    }
    // An event no request can carry is quarantined here, before it is sent.
    // The host already knows the answer, and the 413 branch below only helps
    // when the refusal arrives as a clean 413.
    for (const { event, bytes } of tooLarge) {
      this.quarantine(
        event,
        `event is ${bytes} bytes; one request carries at most ${MAX_REQUEST_BYTES}`,
      );
    }
    if (tooLarge.length > 0)
      this.options.bodies?.drop(
        tooLarge.map(({ event }) => event.event_id_idem),
      );
    if (batch.length === 0)
      return {
        shipped: 0,
        quarantined: tooLarge.length,
        reachable: this.reachable,
      };
    const sent = await this.sendBatch(batch, bodies, ids);
    return { ...sent, quarantined: sent.quarantined + tooLarge.length };
  }

  private async sendBatch(
    batch: TachoEvent[],
    bodies: TachoBody[],
    ids: string[],
  ): Promise<ShipResult> {
    try {
      const response = await this.options.client.ingest(
        batch,
        this.options.health(),
        bodies.length > 0 ? bodies : undefined,
      );
      this.markShipped(batch);
      // The batch is acknowledged, so every body in it is settled: the ones
      // the control plane stored are stored, and the ones it refused it will
      // refuse again for the same reason. Keeping either on the laptop is
      // holding prompt text for nothing.
      this.options.bodies?.drop(ids);
      for (const rejection of response.body_rejections ?? [])
        this.options.log(
          `body refused for ${rejection.event_id_idem}: ${rejection.reason}`,
        );
      this.succeed();
      if (response.chain_breaks.length > 0)
        this.options.onChainBreak?.(response.chain_breaks);
      await this.options.onControl(response.control);
      return { shipped: batch.length, quarantined: 0, reachable: true };
    } catch (error) {
      if (error instanceof ControlUnreachable) {
        this.fail(error);
        return { shipped: 0, quarantined: 0, reachable: false };
      }
      if (
        error instanceof ControlError &&
        (error.status === 400 || error.status === 422 || error.status === 413)
      ) {
        // The control plane refused the batch: malformed (400, 422), or too
        // large for one request (413). Bisect to the event it objects to; a
        // single refused event is quarantined.
        //
        // 413 belongs here even though `fitRequest` bounds what is sent. One
        // sealed event can exceed the limit on its own, because the host
        // never validates an event against `tachoEventSchema` and the hook
        // path stringifies every unpromoted field into `attrs` uncapped. A
        // retry could never make that event smaller, so retrying it forever
        // stops every later event on the host from shipping.
        if (batch.length === 1) {
          this.quarantine(batch[0] as TachoEvent, error.body.slice(0, 512));
          this.succeed();
          return { shipped: 0, quarantined: 1, reachable: true };
        }
        const middle = Math.ceil(batch.length / 2);
        const left = await this.shipBatch(batch.slice(0, middle));
        const right = await this.shipBatch(batch.slice(middle));
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
