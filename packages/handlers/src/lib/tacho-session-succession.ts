/**
 * When an enrolled host may carry on what another enrollment of the same
 * machine recorded (ADR-178).
 *
 * Every enrollment mints its own `tacho.hosts` row, so `enroll --force`, a
 * harness addition and a harness-only reassign each leave the machine under a
 * new host id. tachod keeps a live session's uuid across such a
 * re-enrollment, and the frames the old enrollment recorded but had not
 * shipped leave under the new one's key. Ingest takes both only from a
 * successor: a later enrollment of the same device key, in the same
 * organization and workspace, whose predecessor is revoked.
 *
 * The device key fingerprint is the one the host stated when it enrolled.
 * The control plane does not yet check a signature from that key, so this is
 * a check that the machine says it is the same one, made by a host the
 * workspace already trusts to write its sessions. A session also moves only
 * on a batch that continues its recorded chain.
 */
import { schema, type withTenantDb } from "@oxagen/database";
import { type TachoEvent, verifyChain } from "@oxagen/tacho";
import { inArray } from "drizzle-orm";

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];

/** The host facts succession reads. */
export interface SuccessionHost {
  id: string;
  publicId: string;
  status: string;
  orgId: string;
  workspaceId: string;
  deviceKeyFingerprint: string;
}

/**
 * Whether `host` succeeds `predecessor`: another enrollment of the same
 * device key, in the same organization and workspace, whose predecessor is
 * revoked. The order of the two enrollments is not checked. A live
 * predecessor keeps what it holds, so two enrollments of one machine never
 * write the same session at once.
 */
export function succeedsHost(
  predecessor: SuccessionHost,
  host: SuccessionHost,
): boolean {
  return (
    predecessor.id !== host.id &&
    predecessor.status === "revoked" &&
    predecessor.orgId === host.orgId &&
    predecessor.workspaceId === host.workspaceId &&
    predecessor.deviceKeyFingerprint === host.deviceKeyFingerprint
  );
}

/** A session row's recorded chain head. */
export interface RecordedHead {
  seqCount: number;
  lastHash: string | null;
}

/**
 * Whether a batch carries a session on from its recorded head: the batch's
 * own chain verifies, it leaves no gap, and its first new frame links to the
 * recorded head. A batch that only re-sends recorded frames also passes, and
 * `compareResent` judges each of those against the stored frame. Such a
 * batch proves nothing about the head, so ingest moves no session on it.
 */
export function continuesRecordedChain(
  recorded: RecordedHead,
  events: readonly TachoEvent[],
): boolean {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const first = sorted[0];
  if (first === undefined) return false;
  if (first.seq > recorded.seqCount) return false;
  if (!verifyChain(sorted, { expectGenesis: first.seq === 0 }).ok) return false;
  const head = sorted.find((event) => event.seq >= recorded.seqCount);
  if (head === undefined) return true;
  return recorded.lastHash !== null && head.prev_hash === recorded.lastHash;
}

/**
 * The hosts whose `key` is one of `values`, keyed by it. A revoked host is
 * read like any other, since a revoked host is the one succession asks
 * about. The rows are filtered here as well as in the statement, so a caller
 * never judges a row it did not name.
 */
export async function readSuccessionHosts(
  tx: Tx,
  key: "id" | "publicId",
  values: readonly string[],
): Promise<Map<string, SuccessionHost>> {
  const wanted = new Set(values);
  if (wanted.size === 0) return new Map();
  const rows = (await tx
    .select({
      id: schema.tachoHosts.id,
      publicId: schema.tachoHosts.publicId,
      status: schema.tachoHosts.status,
      orgId: schema.tachoHosts.orgId,
      workspaceId: schema.tachoHosts.workspaceId,
      deviceKeyFingerprint: schema.tachoHosts.deviceKeyFingerprint,
    })
    .from(schema.tachoHosts)
    .where(inArray(schema.tachoHosts[key], [...wanted]))) as SuccessionHost[];
  return new Map(
    rows.filter((row) => wanted.has(row[key])).map((row) => [row[key], row]),
  );
}
