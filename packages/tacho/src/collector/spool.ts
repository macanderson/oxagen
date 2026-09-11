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
import {
  ControlError,
  ControlUnreachable,
  type ControlClient,
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
}

export interface ShipResult {
  shipped: number;
  quarantined: number;
  reachable: boolean;
}

export class Shipper {
  private readonly options: ShipperOptions;
  private backoffMs: number;
  private nextAttemptAt = 0;
  private consecutiveFailures = 0;
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
    this.nextAttemptAt = this.options.now() + this.backoffMs;
    this.backoffMs = Math.min(
      this.backoffMs * 2,
      this.options.maxBackoffMs ?? 60_000,
    );
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

  /** Ship one batch. Returns what moved; the caller loops. */
  async shipOnce(): Promise<ShipResult> {
    if (!this.ready())
      return { shipped: 0, quarantined: 0, reachable: this.reachable };
    const batch = this.options.wal.unshipped(TACHO_MAX_BATCH);
    if (batch.length === 0)
      return { shipped: 0, quarantined: 0, reachable: this.reachable };
    return this.shipBatch(batch);
  }

  private async shipBatch(batch: TachoEvent[]): Promise<ShipResult> {
    try {
      const response = await this.options.client.ingest(
        batch,
        this.options.health(),
      );
      this.markShipped(batch);
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
        (error.status === 400 || error.status === 422)
      ) {
        // The control plane refused the batch as malformed. Bisect to the
        // event it objects to; a single refused event is quarantined.
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
      // 401/403 (revoked or denied key), 413, 429, 5xx: keep the batch, back off.
      this.fail(error);
      this.options.log(`ingest failed: ${this.lastError ?? "unknown"}`);
      return {
        shipped: 0,
        quarantined: 0,
        reachable: !(error instanceof ControlUnreachable),
      };
    }
  }

  /** Ship until the WAL is drained or a failure stops the loop. */
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
    }
  }
}
