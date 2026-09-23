// How a refused write is read before it is worded. The kernel classifies a
// refusal by `reason` and puts the handler's HandlerError reason in `code`
// (ARCHITECTURE.md §3.2). Every page words the same shape the same way: a
// code the page knows gets its own sentence, any other refused code is
// printed as recorded with no cause attached, an invalid input reads as
// such, a parked write names its access request, and an unavailable or
// exhausted answer names its code. Only the vocabulary differs per page.
//
// This module reads the failure into one of those five and hands the page
// the key of the sentence it chose from the page's own words. The page calls
// its translator with a literal key per case, so the message catalogue's
// argument typing still holds at each call and `catalog-used` still sees
// every key read. It sits in the UI kit because the run commands' wording
// lives here too (`command-failure.ts`), and a lane may not import another
// lane's internals.
//
// The failure is typed structurally rather than as the seam's `ActionResult`,
// because this layer has no edge to the kernel seam. Every caller passes the
// seam's own value, so a new `reason` on `ActionResult` fails to compile at
// each call site rather than falling through to a sentence that does not fit.

export type ActionFailure =
  | {
      ok: false;
      reason:
        | "denied"
        | "invalid"
        | "not_found"
        | "conflict"
        | "unavailable"
        | "exhausted";
      code: string;
      field?: string;
    }
  | { ok: false; reason: "pending_approval"; accessRequestId: string };

/**
 * A page's vocabulary: the handler codes it has a sentence for, each mapped
 * to that sentence's message key. `K` is the union of those keys, so the
 * page's translator refuses a key its catalogue does not hold.
 */
export type FailureWords<K extends string> = {
  /** Codes under `denied`, `not_found` and `conflict` with their own sentence. */
  refused: Readonly<Record<string, K>>;
  /** Codes under `invalid` with their own sentence; any other reads as invalid. */
  invalid?: Readonly<Record<string, K>>;
  /** Codes under `unavailable` with their own sentence; any other names its code. */
  unavailable?: Readonly<Record<string, K>>;
};

/** Which sentence a failure gets, and the value that sentence names. */
export type FailureReading<K extends string> =
  | { kind: "named"; key: K }
  | { kind: "refused"; code: string }
  | { kind: "invalid" }
  | { kind: "pendingApproval"; accessRequestId: string }
  | { kind: "unavailable"; code: string };

/** The page's own key for `code`, or null. Own properties only: a code spelt like a prototype member is not a match. */
function named<K extends string>(
  words: Readonly<Record<string, K>> | undefined,
  code: string,
): K | null {
  if (words === undefined || !Object.hasOwn(words, code)) return null;
  return words[code] ?? null;
}

export function readFailure<K extends string>(
  words: FailureWords<K>,
  failure: ActionFailure,
): FailureReading<K> {
  switch (failure.reason) {
    case "denied":
    case "not_found":
    case "conflict": {
      const key = named(words.refused, failure.code);
      return key === null
        ? { kind: "refused", code: failure.code }
        : { kind: "named", key };
    }
    case "invalid": {
      const key = named(words.invalid, failure.code);
      return key === null ? { kind: "invalid" } : { kind: "named", key };
    }
    case "pending_approval":
      return {
        kind: "pendingApproval",
        accessRequestId: failure.accessRequestId,
      };
    case "exhausted":
      return { kind: "unavailable", code: failure.code };
    case "unavailable": {
      const key = named(words.unavailable, failure.code);
      return key === null
        ? { kind: "unavailable", code: failure.code }
        : { kind: "named", key };
    }
  }
}

/**
 * A write that threw before it answered, as the seam would name it. Typed
 * as the one `unavailable` arm so it is assignable to the seam's own
 * `ActionResult` failure as well as to the structural type above.
 */
export function unanswered(code: string): {
  ok: false;
  reason: "unavailable";
  code: string;
} {
  return { ok: false, reason: "unavailable", code };
}
