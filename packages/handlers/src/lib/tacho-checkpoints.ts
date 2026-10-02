/**
 * The signed checkpoints a host's collector seals, kept in `tacho.checkpoints`
 * (ADR-260, #3406).
 *
 * About once a minute the collector seals a `checkpoint` frame on each chain
 * that moved (`checkpoint` in packages/tacho/src/collector/daemon.ts). The
 * frame carries the chain head it covers, the number of frames under that
 * head, and a signature by the host's device key over
 * `<session uuid>:<last covered seq>:<chain head>`.
 *
 * Ingest keeps one row for each such frame that passes every check below,
 * the signature checked against the device key the host enrolled with. So
 * every row `get_run_chain` and `get_tacho_session` read was verified once,
 * here, and a row needs no flag to say so.
 *
 * A frame that fails a check is left out, and the batch is still accepted.
 * A refused batch would be sent again by the host's spool, for ever. The
 * frame still reaches `tacho_events` as the host sent it, so nothing the host
 * recorded is lost. Every check runs before the INSERT, because a failed
 * CHECK constraint would abort the whole tenant transaction, and the
 * session's own update with it.
 */
import { schema, type Tx } from "@oxagen/database";
import { SHA256_DIGEST_PATTERN, type TachoEvent } from "@oxagen/recorder";
import {
  deviceKeyFingerprint,
  verifyDeviceSignature,
} from "@oxagen/recorder/host";

/** Why ingest did not keep a checkpoint frame. */
type CheckpointRefusal =
  /** A member is missing or has the wrong shape. */
  | "malformed"
  /** Its count or its head does not match where the frame sits on the chain. */
  | "position"
  /** It names a key other than the device key the host enrolled with. */
  | "key"
  /** Its signature does not verify under the enrolled device key. */
  | "signature";

type CheckpointInsert = typeof schema.tachoCheckpoints.$inferInsert;

/**
 * The row one checkpoint frame becomes, or the reason it becomes none.
 *
 * The row's `seq` is the last frame the checkpoint covers, which is the
 * sequence the device signed. Anyone can check a row again from its own
 * columns, the session uuid, and the host's public key.
 */
function checkpointRow(
  event: TachoEvent,
  scope: { orgId: string; workspaceId: string },
  sessionId: string,
  devicePublicKey: string,
  now: Date,
): CheckpointInsert | CheckpointRefusal {
  const body = event.body as Record<string, unknown>;
  const chainHead = body["checkpoint_chain_head"];
  const eventCount = body["checkpoint_event_count"];
  const signature = body["checkpoint_device_signature"];
  const fingerprint = body["checkpoint_device_key_fingerprint"];
  const signedAt = new Date(event.ts);
  if (
    typeof chainHead !== "string" ||
    !SHA256_DIGEST_PATTERN.test(chainHead) ||
    typeof eventCount !== "number" ||
    !Number.isSafeInteger(eventCount) ||
    eventCount < 1 ||
    typeof signature !== "string" ||
    signature === "" ||
    typeof fingerprint !== "string" ||
    fingerprint === "" ||
    Number.isNaN(signedAt.getTime())
  )
    return "malformed";
  // The collector seals a checkpoint straight after the frames it covers. Its
  // own seq is the count of frames under it, and its prev_hash is the head it
  // signs. A frame that says otherwise signs some other chain.
  if (eventCount !== event.seq || chainHead !== event.prev_hash)
    return "position";
  if (fingerprint !== deviceKeyFingerprint(devicePublicKey)) return "key";
  const lastSeq = eventCount - 1;
  if (
    !verifyDeviceSignature(
      devicePublicKey,
      `${event.session_uuid}:${lastSeq}:${chainHead}`,
      signature,
    )
  )
    return "signature";
  return {
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
    sessionId,
    seq: lastSeq,
    chainHead,
    eventCount,
    deviceKeyFingerprint: fingerprint,
    deviceSignature: signature,
    signedAt,
    createdAt: now,
  };
}

/**
 * Keep the checkpoints among one session's new frames.
 *
 * `events` are the frames this batch adds to the session, the ones past its
 * recorded head. `devicePublicKey` is the enrolled key of the host that
 * holds the session. A successor shares its predecessor's device key
 * (ADR-179), so the same key verifies the frames either one sealed.
 *
 * The rows go in one statement. A row that is already stored, from an
 * earlier attempt at the same batch, is skipped by the `(session_id, seq)`
 * unique index rather than raising an error. Returns the number of rows
 * written and every frame that was left out, with its reason.
 */
export async function recordCheckpoints(
  tx: Pick<Tx, "insert">,
  scope: { orgId: string; workspaceId: string },
  sessionId: string,
  events: readonly TachoEvent[],
  devicePublicKey: string,
  now: Date,
): Promise<{
  written: number;
  refused: Array<{ seq: number; reason: CheckpointRefusal }>;
}> {
  const rows: CheckpointInsert[] = [];
  const refused: Array<{ seq: number; reason: CheckpointRefusal }> = [];
  for (const event of events) {
    if (event.kind !== "checkpoint") continue;
    const row = checkpointRow(event, scope, sessionId, devicePublicKey, now);
    if (typeof row === "string") refused.push({ seq: event.seq, reason: row });
    else rows.push(row);
  }
  if (rows.length === 0) return { written: 0, refused };
  const written = await tx
    .insert(schema.tachoCheckpoints)
    .values(rows)
    .onConflictDoNothing({
      target: [schema.tachoCheckpoints.sessionId, schema.tachoCheckpoints.seq],
    })
    .returning({ id: schema.tachoCheckpoints.id });
  return { written: written.length, refused };
}
