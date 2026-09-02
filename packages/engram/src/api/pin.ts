/**
 * engram.pin() / engram.unpin() — manage procedural rules.
 *
 * Procedural memories are rules/instructions that guide agent behavior.
 * Pinning a rule gives it maximum salience so it always surfaces in context.
 *
 * Pin state is event-sourced: pin() and unpin() each append a timestamped
 * marker referencing the rule's content-addressed ID, and the compiler treats
 * the LATEST marker per rule as authoritative (see {@link resolveActivePins}).
 * That makes pin-after-unpin genuinely re-pin the rule — the re-pin marker's
 * newer timestamp wins — which content addressing alone could not express (the
 * re-pinned procedural record is byte-identical to the original, so its ID and
 * createdAt never change on the second pin).
 */
import { createRecord } from "../record";
import { validateNamespace } from "../namespace";
import type { MemoryRecord, ProceduralBody, WriteOpts } from "../types";
import type { EpisodicStore } from "../store/episodic";

/** Pinned rules get maximum salience to ensure they surface in compile(). */
const PINNED_SALIENCE = 1.0;

/** Episodic event name written when a rule is pinned. */
export const PIN_EVENT_PINNED = "rule_pinned";
/** Episodic event name written when a rule is unpinned. */
export const PIN_EVENT_UNPINNED = "rule_unpinned";

/**
 * Pin a procedural rule into memory with maximum salience.
 *
 * Writes the procedural record (content-addressed, so re-pinning an identical
 * rule is idempotent at the storage layer) plus a `rule_pinned` marker whose
 * timestamp reactivates a previously-unpinned rule.
 *
 * @returns The content-addressed ID of the pinned record.
 */
export async function pin(
  store: EpisodicStore,
  rule: ProceduralBody,
  opts: WriteOpts,
): Promise<string> {
  const namespace = validateNamespace(opts.namespace);

  const record: MemoryRecord = createRecord({
    kind: "procedural",
    namespace,
    body: rule,
    salience: PINNED_SALIENCE,
    confidence: 1.0,
    provenance: opts.provenance,
    causality: opts.causality,
  });

  await store.append(record);

  // Marker so the compiler can resolve pin-after-unpin: a `rule_pinned` event
  // dated after any prior `rule_unpinned` re-activates the rule.
  const marker: MemoryRecord = createRecord({
    kind: "episodic",
    namespace,
    body: {
      event: PIN_EVENT_PINNED,
      payload: { ruleId: record.id },
      outcome: "success",
    },
    salience: 0.1,
    confidence: 1.0,
    provenance: opts.provenance,
    causality: [record.id],
  });
  await store.append(marker);

  return record.id;
}

/**
 * Unpin a procedural rule by appending a `rule_unpinned` marker.
 *
 * The rule's procedural record is left in place (recoverable via a later pin);
 * the compiler suppresses it from the pinned set as long as the newest marker
 * for this rule is the unpin. A subsequent {@link pin} of the same rule wins by
 * timestamp and re-activates it.
 */
export async function unpin(
  store: EpisodicStore,
  ruleId: string,
  opts: WriteOpts,
): Promise<void> {
  const namespace = validateNamespace(opts.namespace);

  const record: MemoryRecord = createRecord({
    kind: "episodic",
    namespace,
    body: {
      event: PIN_EVENT_UNPINNED,
      payload: { ruleId },
      outcome: "success",
    },
    salience: 0.1,
    confidence: 1.0,
    provenance: opts.provenance,
    causality: [ruleId],
  });

  await store.append(record);
}

/**
 * Resolve which pinned procedural records are still active, given the pin/unpin
 * marker events for the namespace.
 *
 * A rule is suppressed iff its most recent marker (by `createdAt`) is a
 * `rule_unpinned`. Rules with no markers stay active (they were pinned by a
 * path that didn't emit markers, or predate marker support). Because two
 * markers can share a millisecond timestamp, a `rule_pinned` wins ties so a
 * same-tick re-pin is honored.
 */
export function resolveActivePins(
  pinnedRecords: MemoryRecord[],
  markerEvents: MemoryRecord[],
): MemoryRecord[] {
  // ruleId -> { at, pinned } for the newest marker seen.
  const latest = new Map<string, { at: number; pinned: boolean }>();

  for (const ev of markerEvents) {
    const body = ev.body as { event?: unknown; payload?: unknown };
    const isPin = body.event === PIN_EVENT_PINNED;
    const isUnpin = body.event === PIN_EVENT_UNPINNED;
    if (!isPin && !isUnpin) continue;

    const payload = body.payload as { ruleId?: unknown } | undefined;
    const ruleId =
      typeof payload?.ruleId === "string" ? payload.ruleId : undefined;
    if (!ruleId) continue;

    const at = Number(ev.createdAt);
    const prev = latest.get(ruleId);
    // Newer timestamp wins; on a tie a pin beats an unpin (re-pin is intent).
    if (!prev || at > prev.at || (at === prev.at && isPin)) {
      latest.set(ruleId, { at, pinned: isPin });
    }
  }

  return pinnedRecords.filter((r) => {
    const state = latest.get(r.id);
    return state ? state.pinned : true;
  });
}
