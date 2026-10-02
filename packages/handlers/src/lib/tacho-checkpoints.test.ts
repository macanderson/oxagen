/**
 * The collector's signed checkpoints, as ingest keeps them (ADR-260, #3406).
 *
 * Each case builds a real chain: two frames, then the `checkpoint` frame the
 * collector seals after them, signed by a real Ed25519 device key the way
 * `checkpoint` in packages/tacho/src/collector/daemon.ts signs it. A case
 * that breaks the checkpoint breaks one member and seals the frame again, so
 * the frame stays a valid link on its chain and only the checkpoint is wrong.
 */
import { schema, type Tx } from "@oxagen/database";
import {
  type ChainCursor,
  GENESIS_CURSOR,
  type TachoEvent,
  type UnsealedTachoEvent,
  sealEvent,
  sessionUuid,
} from "@oxagen/recorder";
import {
  type DeviceKey,
  generateDeviceKey,
  verifyDeviceSignature,
} from "@oxagen/recorder/host";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { recordCheckpoints } from "./tacho-checkpoints";

const HOST_PUBLIC = "tch_0123456789abcdefghjkmn";
const SCOPE = {
  orgId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
};
/** `tacho.sessions.id`, the key the rows are stored under. */
const SESSION_ROW = "0192d4a8-7c1e-7000-8000-00000000c0de";
const SESSION = sessionUuid(HOST_PUBLIC, "sess-1");
const SIGNED_AT = "2026-09-08T10:07:00.000Z";
const NOW = new Date("2026-09-08T10:10:00.000Z");

/** The device key the host enrolled with. */
const ENROLLED = generateDeviceKey();
/** A key the host never enrolled. */
const OTHER = generateDeviceKey();

function draft(
  kind: UnsealedTachoEvent["kind"],
  body: Record<string, unknown>,
  ts = "2026-09-08T10:06:03.000Z",
): UnsealedTachoEvent {
  return {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "sess-1",
    session_uuid: SESSION,
    root_session_uuid: SESSION,
    ts,
    fidelity: "sdk",
    source: "collector",
    agent: {
      agent_key: "acme.core.cc-laptop",
      fleet_id: "wrk_1",
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: "2.1.1",
      host_enrollment_id: HOST_PUBLIC,
    },
    kind,
    body,
  } as UnsealedTachoEvent;
}

/**
 * Two frames, then the checkpoint the collector seals over them: its count
 * is the frames under it, its head is the last frame's hash, and `signer`
 * signs `<session uuid>:<last seq>:<head>`. `override` replaces members of
 * the checkpoint's body, given the cursor the checkpoint seals at.
 */
function chainWithCheckpoint(
  signer: DeviceKey = ENROLLED,
  override: (cursor: ChainCursor) => Record<string, unknown> = () => ({}),
): TachoEvent[] {
  let cursor: ChainCursor = GENESIS_CURSOR;
  const out: TachoEvent[] = [];
  for (const frame of [
    draft("agent_start", { session_start_source: "startup" }),
    draft("turn_start", { prompt_length: 3 }),
  ]) {
    const sealed = sealEvent(frame, cursor);
    cursor = sealed.next;
    out.push(sealed.event);
  }
  const lastSeq = cursor.seq - 1;
  const checkpoint = sealEvent(
    draft(
      "checkpoint",
      {
        checkpoint_id: "01J8ZQ00000000000000000000",
        checkpoint_event_count: lastSeq + 1,
        checkpoint_chain_head: cursor.prevHash,
        checkpoint_device_signature: signer.sign(
          `${SESSION}:${lastSeq}:${cursor.prevHash}`,
        ),
        checkpoint_device_key_fingerprint: signer.fingerprint,
        ...override(cursor),
      },
      SIGNED_AT,
    ),
    cursor,
  );
  out.push(checkpoint.event);
  return out;
}

/**
 * A transaction holding `tacho.checkpoints` in memory. The INSERT honours
 * the `(session_id, seq)` unique index the way `ON CONFLICT DO NOTHING`
 * does: a row the table already holds is skipped, and `RETURNING` names
 * only the rows written.
 */
function memoryTx() {
  const stored: Array<Record<string, unknown>> = [];
  const statements: Array<{ table: unknown; target: unknown[] }> = [];
  const tx = {
    insert: (table: unknown) => ({
      values: (rows: Array<Record<string, unknown>>) => ({
        onConflictDoNothing: (config: { target: unknown[] }) => ({
          returning: async () => {
            statements.push({ table, target: config.target });
            const written: Array<{ id: string }> = [];
            for (const row of rows) {
              const held = stored.some(
                (one) =>
                  one["sessionId"] === row["sessionId"] &&
                  one["seq"] === row["seq"],
              );
              if (held) continue;
              stored.push(row);
              written.push({ id: `row-${stored.length}` });
            }
            return written;
          },
        }),
      }),
    }),
  };
  return { tx: tx as unknown as Pick<Tx, "insert">, stored, statements };
}

describe("recordCheckpoints", () => {
  it("keeps a checkpoint whose signature verifies, keyed by the last frame it covers", async () => {
    const events = chainWithCheckpoint();
    const head = (events[1] as TachoEvent).hash;
    const db = memoryTx();

    const result = await recordCheckpoints(
      db.tx,
      SCOPE,
      SESSION_ROW,
      events,
      ENROLLED.publicKey,
      NOW,
    );

    expect(result).toEqual({ written: 1, refused: [] });
    expect(db.stored).toEqual([
      {
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        sessionId: SESSION_ROW,
        seq: 1,
        chainHead: head,
        eventCount: 2,
        deviceKeyFingerprint: ENROLLED.fingerprint,
        deviceSignature: expect.any(String),
        signedAt: new Date(SIGNED_AT),
        createdAt: NOW,
      },
    ]);
    // A stored row checks again from its own columns, the session uuid and
    // the host's public key.
    const row = db.stored[0] as Record<string, unknown>;
    expect(
      verifyDeviceSignature(
        ENROLLED.publicKey,
        `${SESSION}:${String(row["seq"])}:${String(row["chainHead"])}`,
        String(row["deviceSignature"]),
      ),
    ).toBe(true);
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]?.table).toBe(schema.tachoCheckpoints);
    expect(db.statements[0]?.target[0]).toBe(
      schema.tachoCheckpoints.sessionId,
    );
    expect(db.statements[0]?.target[1]).toBe(schema.tachoCheckpoints.seq);
  });

  it("writes no second row when the same frames arrive again", async () => {
    const events = chainWithCheckpoint();
    const db = memoryTx();

    await recordCheckpoints(
      db.tx,
      SCOPE,
      SESSION_ROW,
      events,
      ENROLLED.publicKey,
      NOW,
    );
    const retry = await recordCheckpoints(
      db.tx,
      SCOPE,
      SESSION_ROW,
      events,
      ENROLLED.publicKey,
      NOW,
    );

    expect(retry).toEqual({ written: 0, refused: [] });
    expect(db.stored).toHaveLength(1);
  });

  it("leaves out a checkpoint another key signed under the enrolled key's name (negative)", async () => {
    const events = chainWithCheckpoint(OTHER, () => ({
      checkpoint_device_key_fingerprint: ENROLLED.fingerprint,
    }));
    const db = memoryTx();

    const result = await recordCheckpoints(
      db.tx,
      SCOPE,
      SESSION_ROW,
      events,
      ENROLLED.publicKey,
      NOW,
    );

    expect(result).toEqual({
      written: 0,
      refused: [{ seq: 2, reason: "signature" }],
    });
    // Nothing reaches the database, so no statement can abort the batch's
    // transaction.
    expect(db.statements).toHaveLength(0);
  });

  it("leaves out a checkpoint that names a key the host did not enroll (negative)", async () => {
    const events = chainWithCheckpoint(OTHER);
    const db = memoryTx();

    const result = await recordCheckpoints(
      db.tx,
      SCOPE,
      SESSION_ROW,
      events,
      ENROLLED.publicKey,
      NOW,
    );

    expect(result.refused).toEqual([{ seq: 2, reason: "key" }]);
    expect(db.stored).toHaveLength(0);
  });

  it.each([
    {
      name: "a count that is not its own place on the chain",
      // Signed honestly for one frame, but sealed after two.
      override: (cursor: ChainCursor) => ({
        checkpoint_event_count: 1,
        checkpoint_device_signature: ENROLLED.sign(
          `${SESSION}:0:${cursor.prevHash}`,
        ),
      }),
    },
    {
      name: "a head that is not the frame before it",
      override: () => {
        const other = `sha256:${"e".repeat(64)}`;
        return {
          checkpoint_chain_head: other,
          checkpoint_device_signature: ENROLLED.sign(`${SESSION}:1:${other}`),
        };
      },
    },
  ])(
    "leaves out a signed checkpoint with $name (negative)",
    async ({ override }) => {
      const events = chainWithCheckpoint(ENROLLED, override);
      const db = memoryTx();

      const result = await recordCheckpoints(
        db.tx,
        SCOPE,
        SESSION_ROW,
        events,
        ENROLLED.publicKey,
        NOW,
      );

      expect(result.refused).toEqual([{ seq: 2, reason: "position" }]);
      expect(db.stored).toHaveLength(0);
    },
  );

  it("leaves out a checkpoint that carries no signature (negative)", async () => {
    const events = chainWithCheckpoint(ENROLLED, () => ({
      checkpoint_device_signature: undefined,
    }));
    const db = memoryTx();

    const result = await recordCheckpoints(
      db.tx,
      SCOPE,
      SESSION_ROW,
      events,
      ENROLLED.publicKey,
      NOW,
    );

    expect(result.refused).toEqual([{ seq: 2, reason: "malformed" }]);
    expect(db.stored).toHaveLength(0);
  });

  it("sends no statement for a batch with no checkpoint frame", async () => {
    const events = chainWithCheckpoint().slice(0, 2);
    const db = memoryTx();

    const result = await recordCheckpoints(
      db.tx,
      SCOPE,
      SESSION_ROW,
      events,
      ENROLLED.publicKey,
      NOW,
    );

    expect(result).toEqual({ written: 0, refused: [] });
    expect(db.statements).toHaveLength(0);
  });

  it("sends one INSERT that skips a row the unique index already holds", async () => {
    const stmts: Array<{ sql: string; params: unknown[] }> = [];
    const tx = drizzle(
      async (sql, params) => {
        stmts.push({ sql, params });
        return { rows: [["0192d4a8-7c1e-7000-8000-0000000000f1"]] };
      },
      { schema },
    ) as unknown as Tx;

    const result = await recordCheckpoints(
      tx,
      SCOPE,
      SESSION_ROW,
      chainWithCheckpoint(),
      ENROLLED.publicKey,
      NOW,
    );

    expect(result.written).toBe(1);
    expect(stmts).toHaveLength(1);
    const sql = stmts[0]?.sql ?? "";
    expect(sql).toMatch(/^insert into "tacho"\."checkpoints"/);
    expect(sql).toMatch(/on conflict \("session_id",\s*"seq"\) do nothing/);
    expect(sql).toMatch(/returning "id"$/);
    expect(stmts[0]?.params).toContain(SESSION_ROW);
    expect(stmts[0]?.params).toContain(SCOPE.orgId);
    expect(stmts[0]?.params).toContain(SCOPE.workspaceId);
  });
});
