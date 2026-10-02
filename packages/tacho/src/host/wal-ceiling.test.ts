/**
 * The WAL ceiling (ADR-260, #3722): sessions the control plane stopped
 * accepting lose their stored bodies, longest stalled first, once they hold
 * more than the ceiling. Their events stay, so the chain still verifies.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../chain";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { sealAll, unsealed } from "../test-helpers";
import { scratchPaths } from "./test-support";
import { Wal } from "./wal";
import {
  readWalCeilingState,
  WalCeiling,
  type WalCeilingDrop,
  type WalCeilingPolicy,
} from "./wal-ceiling";

const OLDER = "5c1f0a2e-0000-4000-8000-0000000000a1";
const NEWER = "5c1f0a2e-0000-4000-8000-0000000000b2";
const T0 = Date.parse("2026-10-02T12:00:00.000Z");
const MINUTE = 60_000;
const GRACE = 10 * MINUTE;
const WEEK = 7 * 24 * 60 * MINUTE;

/** `count` model calls on one session at `ts`, each with a body of `size` bytes. */
function seed(
  wal: Wal,
  uuid: string,
  ts: string,
  count = 4,
  size = 4096,
): TachoEvent[] {
  const events = sealAll(
    Array.from({ length: count }, () =>
      unsealed(
        "llm_call",
        {
          model: "claude-haiku-4-5-20251001",
          input_tokens: 10,
          output_tokens: 5,
          context_window: 200_000,
        },
        {
          session_uuid: uuid,
          root_session_uuid: uuid,
          session_id: uuid,
          ts,
          source: "otel_log",
          turn: { turn_seq: 1, prompt_id: "p1" },
        },
      ),
    ),
  );
  const bodies: FrameBody[] = events.map((event) => ({
    event_id_idem: event.event_id_idem,
    session_uuid: uuid,
    seq: event.seq,
    content_type: "text/plain; charset=utf-8",
    bytes: new TextEncoder().encode("x".repeat(size)),
    content_class: "model_call",
  }));
  wal.append(events, bodies);
  return events;
}

function policy(overrides: Partial<WalCeilingPolicy> = {}): WalCeilingPolicy {
  return {
    ceilingBytes: 1,
    stallGraceMs: GRACE,
    checkEveryMs: MINUTE,
    freeBytes: () => undefined,
    ...overrides,
  };
}

const ignore = (): void => undefined;

function held(wal: Wal, uuid: string): { events: number; bodies: number } {
  const holding = wal.holdings().find((h) => h.sessionUuid === uuid);
  if (holding === undefined) throw new Error(`${uuid} holds nothing`);
  return { events: holding.eventBytes, bodies: holding.bodyBytes };
}

describe("the WAL ceiling", () => {
  it("drops the stored bodies of the session stalled longest until the rest fit, and keeps every event", () => {
    const dir = scratchPaths().wal;
    const wal = new Wal(dir);
    const older = seed(wal, OLDER, "2026-10-01T09:00:00.000Z");
    seed(wal, NEWER, "2026-10-02T09:00:00.000Z");
    const o = held(wal, OLDER);
    const n = held(wal, NEWER);
    // Room for everything except the older session's bodies.
    const ceilingBytes = o.events + n.events + n.bodies;
    const ceiling = new WalCeiling(
      wal,
      dir,
      policy({ ceilingBytes }),
      WEEK,
      ignore,
    );
    const recorded: WalCeilingDrop[] = [];

    // The first check starts each session's clock, so nothing is stalled yet.
    expect(ceiling.check(T0, (drop) => recorded.push(drop))).toEqual([]);
    const drops = ceiling.check(T0 + GRACE, (drop) => recorded.push(drop));

    // Both stalled equally long, so the one whose last event is older goes.
    expect(drops.map((drop) => drop.session_uuid)).toEqual([OLDER]);
    expect(recorded).toEqual(drops);
    expect(drops[0]).toMatchObject({
      bytes: o.bodies,
      shipped_through: -1,
      last_seq: 3,
      stalled_since: new Date(T0).toISOString(),
      dropped_at: new Date(T0 + GRACE).toISOString(),
      stalled_bytes: o.events + o.bodies + n.events + n.bodies,
      ceiling_bytes: ceilingBytes,
    });
    expect(existsSync(join(dir, `${OLDER}.bodies.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `${NEWER}.bodies.jsonl`))).toBe(true);

    // The chain is whole. Only the content went.
    expect(wal.read(OLDER)).toEqual(older);
    expect(verifyChain(wal.read(OLDER)).ok).toBe(true);
    expect(wal.bodiesFor(older)).toEqual([]);

    const state = readWalCeilingState(dir);
    expect(state).toMatchObject({
      stalled_sessions: 2,
      ceiling_bytes: ceilingBytes,
      stall_grace_ms: GRACE,
      drops: [{ session_uuid: OLDER }],
    });
    expect(state?.stalled_bytes).toBeLessThanOrEqual(ceilingBytes);
  });

  it("never counts a session whose shipped cursor keeps moving, however much it holds", () => {
    const dir = scratchPaths().wal;
    const wal = new Wal(dir);
    seed(wal, OLDER, "2026-10-02T09:00:00.000Z", 8);
    const ceiling = new WalCeiling(wal, dir, policy(), WEEK, ignore);
    const bodies = join(dir, `${OLDER}.bodies.jsonl`);

    // A slow shipper: one event every five minutes, against a 1-byte ceiling.
    for (let step = 0; step <= 6; step += 1) {
      expect(ceiling.check(T0 + step * 5 * MINUTE, ignore)).toEqual([]);
      wal.markShipped(OLDER, step);
    }
    expect(existsSync(bodies)).toBe(true);
    // Nothing stalled and nothing dropped, so there is nothing to report.
    expect(existsSync(join(dir, "ceiling.json"))).toBe(false);

    // The cursor stops at 6. The grace runs from the check that saw it there.
    expect(ceiling.check(T0 + 35 * MINUTE, ignore)).toEqual([]);
    const drops = ceiling.check(T0 + 35 * MINUTE + GRACE, ignore);
    expect(drops).toMatchObject([
      { session_uuid: OLDER, shipped_through: 6, last_seq: 7 },
    ]);
    expect(existsSync(bodies)).toBe(false);
  });

  it("keeps half the space the disk would have free, when that is less than the fixed figure", () => {
    const dir = scratchPaths().wal;
    const wal = new Wal(dir);
    seed(wal, OLDER, "2026-10-01T09:00:00.000Z");
    seed(wal, NEWER, "2026-10-02T09:00:00.000Z");
    const o = held(wal, OLDER);
    const n = held(wal, NEWER);
    const total = o.events + o.bodies + n.events + n.bodies;
    // A disk with nothing free: the stalled sessions may keep half of what
    // they hold, whatever the fixed figure says.
    const ceiling = new WalCeiling(
      wal,
      dir,
      policy({ ceilingBytes: 1024 ** 4, freeBytes: () => 0 }),
      WEEK,
      ignore,
    );

    ceiling.check(T0, ignore);
    const drops = ceiling.check(T0 + GRACE, ignore);

    expect(drops.map((drop) => drop.session_uuid)).toEqual([OLDER, NEWER]);
    expect(drops[0]?.ceiling_bytes).toBe(Math.floor(total / 2));
    expect(readWalCeilingState(dir)?.stalled_bytes).toBe(
      o.events + n.events,
    );
  });

  it("keeps each drop in ceiling.json across a restart, for the WAL's retention", () => {
    const dir = scratchPaths().wal;
    const wal = new Wal(dir);
    seed(wal, OLDER, "2026-10-02T09:00:00.000Z");
    const first = new WalCeiling(wal, dir, policy(), WEEK, ignore);
    first.check(T0, ignore);
    expect(first.check(T0 + GRACE, ignore)).toHaveLength(1);

    // A restarted daemon starts every clock again, and keeps the history.
    const second = new WalCeiling(wal, dir, policy(), WEEK, ignore);
    expect(second.check(T0 + GRACE + MINUTE, ignore)).toEqual([]);
    expect(readWalCeilingState(dir)?.drops).toMatchObject([
      { session_uuid: OLDER },
    ]);

    second.check(T0 + GRACE + WEEK, ignore);
    expect(readWalCeilingState(dir)?.drops).toEqual([]);
  });

  it("reads a missing or foreign ceiling.json as nothing", () => {
    const dir = scratchPaths().wal;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "ceiling.json");
    expect(readWalCeilingState(dir)).toBeUndefined();
    writeFileSync(file, "{not json");
    expect(readWalCeilingState(dir)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ schema: "something.else" }));
    expect(readWalCeilingState(dir)).toBeUndefined();
  });
});
